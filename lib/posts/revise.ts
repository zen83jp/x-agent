import { stripMentions } from "../dm/assist";
import { esc } from "../dm/slack";
import { postThreadReply } from "../slack/client";
import { db } from "../supabase";
import { dayContext } from "./calendar";
import { loadDraft, refreshDraftApproval, type DraftRow } from "./approval";
import { writeAndReview } from "./writer";

export async function findDraftByThread(threadTs: string): Promise<DraftRow | null> {
  const { data, error } = await db().from("post_drafts").select("id").eq("slack_ts", threadTs).maybeSingle();
  if (error) throw error;
  return data ? loadDraft(data.id) : null;
}

/**
 * 【投稿承認】のスレッドでの修正指示（「もっと短く」など）を反映して作り直す。
 * 指示は積み重ねて渡し、審査をやり直したうえで承認メッセージを新しい案に差し替える。
 */
export async function reviseDraft(draft: DraftRow, messageTs: string, rawText: string | undefined): Promise<void> {
  const instruction = stripMentions(rawText);
  if (!instruction) return;
  const say = (text: string, mrkdwn = true) =>
    postThreadReply({ channel: draft.slack_channel!, threadTs: draft.slack_ts!, text, mrkdwn });

  const { data: rev, error } = await db()
    .from("post_draft_revisions")
    .insert({ slack_ts: messageTs, draft_id: draft.id, instruction })
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
      .select("id, instruction")
      .eq("draft_id", draft.id)
      .lte("id", rev.id)
      .order("id");
    if (hErr) throw hErr;
    const instructions = (history ?? []).map((h) => h.instruction);
    const topic = Array.isArray(draft.post_topics) ? draft.post_topics[0] : draft.post_topics;

    const written = await writeAndReview({
      kind: draft.kind,
      day: draft.day_context ?? dayContext(new Date().toISOString().slice(0, 10)),
      topic: topic?.body,
      revision: { previousBody: draft.body, instructions },
      excludeDraftId: draft.id,
    });
    if ("failed" in written) return void (await say(`:warning: 作り直しに失敗しました（${esc(written.failed)}）`));

    // 承認待ちのままのときだけ差し替える（作り直しの間に承認・却下されていたら上書きしない）
    const { data: updated, error: uErr } = await db()
      .from("post_drafts")
      .update({ body: written.body, reason: written.reason, theme: written.theme, review_note: written.review })
      .eq("id", draft.id)
      .eq("review_status", "awaiting_approval")
      .select("id");
    if (uErr) throw uErr;
    await db().from("post_draft_revisions").update({ body: written.body, review: written.review }).eq("id", rev.id);
    if (!updated?.length) return void (await say("作り直している間に承認・却下されたため、差し替えませんでした。"));

    await refreshDraftApproval(draft.id);
    await say(`指示を反映しました（${instructions.length}回目）。上のメッセージを差し替えました。`);
    await say(written.body, false);
  } catch (e) {
    console.error("reviseDraft failed", e);
    await say(`:warning: 作り直し中にエラーが発生しました（${e instanceof Error ? e.message : String(e)}）`);
  }
}
