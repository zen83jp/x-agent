import { stripMentions, stripSlackFooter } from "../dm/assist";
import { esc } from "../dm/slack";
import { postThreadReply } from "../slack/client";
import { db } from "../supabase";
import { dayContext } from "./calendar";
import { loadDraft, refreshDraftApproval, type DraftRow } from "./approval";
import { AMBIGUOUS_REVERT_GUIDE, classifyRevert } from "./revert";
import type { ReviewNote } from "./schemas";
import { reviewNotes } from "./slack";
import { checkWithoutWriting, writeAndReview } from "./writer";

export async function findDraftByThread(threadTs: string): Promise<DraftRow | null> {
  const { data, error } = await db().from("post_drafts").select("id").eq("slack_ts", threadTs).maybeSingle();
  if (error) throw error;
  return data ? loadDraft(data.id) : null;
}

type RevisionRow = { id: number; instruction: string; body: string | null; previous_body: string | null };

/**
 * 書き手に渡す指示: 最後に「戻した」ところより後の、通常の修正の指示だけ（古い順）。
 * 戻す指示・どちらか判断できない指示は渡さない
 */
export function instructionsSinceLastRevert(history: RevisionRow[]): string[] {
  const texts = history.map((h) => stripSlackFooter(h.instruction));
  let start = 0;
  texts.forEach((t, i) => {
    const kind = classifyRevert(t);
    if (kind === "original" || kind === "previous") start = i + 1;
  });
  return texts.slice(start).filter((t) => classifyRevert(t) === null);
}

/**
 * 「1つ前に戻す」ときの戻し先: 今回より前の、本文が変わった最新の修正の、修正前の本文
 */
export function previousVersion(history: RevisionRow[], currentRevisionId: number): string | null {
  const earlier = history.filter((h) => h.id < currentRevisionId && h.body !== null && h.previous_body !== null);
  return earlier.at(-1)?.previous_body ?? null;
}

/**
 * 【投稿承認】のスレッドでの修正指示を反映する。
 * - 「原文に戻して」「1つ前に戻して」: Claude を呼ばず、保存した本文に戻す（機械チェックは通す）
 * - 「戻して」だけなど、どちらか判断できない指示: 戻さず、言い方を案内する
 * - それ以外: 指示を積み重ねて作り直し、審査をやり直したうえで承認メッセージを新しい案に差し替える
 * 承認待ちの案だけを対象にする（承認済み・却下・期限切れの案の本文は変えない）。
 */
export async function reviseDraft(draft: DraftRow, messageTs: string, rawText: string | undefined): Promise<void> {
  const instruction = stripMentions(rawText);
  if (!instruction) return;
  const say = (text: string, mrkdwn = true) =>
    postThreadReply({ channel: draft.slack_channel!, threadTs: draft.slack_ts!, text, mrkdwn });

  // 修正前の本文も一緒に残す（「1つ前に戻して」と、のちの修正の傾向の分析に使う）
  const { data: rev, error } = await db()
    .from("post_draft_revisions")
    .insert({ slack_ts: messageTs, draft_id: draft.id, instruction, previous_body: draft.body })
    .select("id")
    .single();
  if (error?.code === "23505") return;
  if (error) throw error;

  try {
    if (draft.review_status !== "awaiting_approval") {
      return void (await say("承認待ちではないため修正できません（承認済み・却下・期限切れ）。"));
    }
    const { data: history, error: hErr } = await db()
      .from("post_draft_revisions")
      .select("id, instruction, body, previous_body")
      .eq("draft_id", draft.id)
      .lte("id", rev.id)
      .order("id");
    if (hErr) throw hErr;
    const rows = (history ?? []) as RevisionRow[];
    const isFirst = rows.length === 1;

    // 原文が未保存なら、最初の修正の時点の本文を原文として保存する（010 より前の案は、すでに修正済みなら補えない）
    if (isFirst && !draft.original_body) {
      await db().from("post_drafts").update({ original_body: draft.body }).eq("id", draft.id).is("original_body", null);
      draft = { ...draft, original_body: draft.body };
    }
    // 最初の修正のときだけ、修正前の本文を【原文】としてスレッドに残す（1スレッド目は最新の案に差し替えるため）
    if (isFirst) await say(`【原文】\n${draft.body}`, false);

    const kind = classifyRevert(instruction);
    if (kind === "ambiguous") return void (await say(`戻し先が判断できないため、変更していません。${AMBIGUOUS_REVERT_GUIDE}`));
    if (kind === "original" || kind === "previous") {
      const target = kind === "original" ? draft.original_body : previousVersion(rows, rev.id);
      const label = kind === "original" ? "原文" : "1つ前の案";
      if (!target) {
        return void (await say(kind === "original" ? "原文が保存されていないため戻せません。" : "戻せる1つ前の案がありません。"));
      }
      if (target === draft.body) return void (await say(`すでに${label}と同じ本文です（変更なし）。`));
      return void (await restore(draft, rev.id, target, label, say));
    }

    const topic = Array.isArray(draft.post_topics) ? draft.post_topics[0] : draft.post_topics;
    const instructions = instructionsSinceLastRevert(rows);
    // 同じ週の案（前日を含む）は writer が DB から読む
    const written = await writeAndReview({
      kind: draft.kind,
      day: draft.day_context ?? dayContext(new Date().toISOString().slice(0, 10)),
      topic: topic?.body,
      revision: { previousBody: draft.body, instructions },
      excludeDraftId: draft.id,
    });
    if ("failed" in written) return void (await say(`:warning: 修正できませんでした（${esc(written.failed)}）`));

    const applied = await applyBody(draft.id, rev.id, { body: written.body, reason: written.reason, theme: written.theme, review: written.review });
    if (!applied) return void (await say("作り直している間に承認・却下されたため、差し替えませんでした。"));

    await refreshDraftApproval(draft.id);
    await say(summaryWithNotes(`修正しました（${rows.length}回目）。上のメッセージを最新の案に差し替えました。`, written.review));
    await say(written.body, false);
  } catch (e) {
    console.error("reviseDraft failed", e);
    await say(`:warning: 作り直し中にエラーが発生しました（${e instanceof Error ? e.message : String(e)}）`);
  }
}

function summaryWithNotes(head: string, review: ReviewNote): string {
  const notes = reviewNotes(review);
  return [head, ...(notes.length ? [`:warning: *要確認*\n${notes.map((n) => `• ${esc(n)}`).join("\n")}`] : [])].join("\n");
}

/** 承認待ちのままのときだけ本文を差し替え、修正の記録にも残す。差し替えたら true */
async function applyBody(
  draftId: number,
  revisionId: number,
  next: { body: string; reason?: string | null; theme?: string | null; review: ReviewNote },
): Promise<boolean> {
  const { data, error } = await db()
    .from("post_drafts")
    .update({
      body: next.body,
      ...(next.reason !== undefined ? { reason: next.reason } : {}),
      ...(next.theme !== undefined ? { theme: next.theme } : {}),
      review_note: next.review,
    })
    .eq("id", draftId)
    .eq("review_status", "awaiting_approval")
    .select("id");
  if (error) throw error;
  await db().from("post_draft_revisions").update({ body: next.body, review: next.review }).eq("id", revisionId);
  return Boolean(data?.length);
}

/** Claude を通さずに保存した本文へ戻す。機械チェックは通し、URL などがあれば戻さない */
async function restore(
  draft: DraftRow,
  revisionId: number,
  target: string,
  label: string,
  say: (text: string, mrkdwn?: boolean) => Promise<void>,
): Promise<void> {
  const checked = await checkWithoutWriting(
    { kind: draft.kind, day: draft.day_context ?? dayContext(new Date().toISOString().slice(0, 10)), excludeDraftId: draft.id },
    target,
    draft.theme ?? "",
  );
  if (checked.fatal.length) {
    return void (await say(`:warning: ${label}に戻せませんでした（${esc(checked.fatal.join("、"))}）`));
  }
  const applied = await applyBody(draft.id, revisionId, { body: target, review: checked.review });
  if (!applied) return void (await say("処理している間に承認・却下されたため、戻しませんでした。"));
  await refreshDraftApproval(draft.id);
  await say(summaryWithNotes(`${label}に戻しました。上のメッセージを差し替えました。`, checked.review));
  await say(target, false);
}
