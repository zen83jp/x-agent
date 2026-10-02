import { openModal, postThreadReply } from "../slack/client";
import type { ActionContext, ActionResult } from "../slack/actions";
import { db } from "../supabase";
import { sendDm } from "../x/dm";
import { loadApprovalView, markApprovalDone } from "./approval";
import { appendMeetingNote, sendBlockers } from "./generate";
import { env } from "../env";
import { BLOCK_PREFIX, isBlocked } from "./rules";
import { isLeadCategory, upsertLead } from "./leads";
import type { Classification } from "./schemas";

type ClaimedRow = {
  id: number;
  thread_id: number;
  category: string | null;
  classification: Classification | null;
  draft_reply: string | null;
  decline_reply: string | null;
  needs_human_check: string[] | null;
  dm_threads: { x_conversation_id: string; x_user_id: string; x_username: string | null; x_name: string | null };
};

const SELECT =
  "id, thread_id, category, classification, draft_reply, decline_reply, needs_human_check, dm_threads(x_conversation_id, x_user_id, x_username, x_name)";

function parseId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`不正な dm_messages.id: ${value}`);
  return id;
}

/**
 * 処理権を取る。pending（または送信失敗）の行を1回の更新で別の状態に変え、取れた実行だけが続きを行う。
 * 二重押下・並行実行で二重送信しないための仕組み。取れなければ null。
 */
async function claim(id: number, to: "sending" | "skipped"): Promise<ClaimedRow | null> {
  const { data, error } = await db()
    .from("dm_messages")
    .update({ send_status: to })
    .eq("id", id)
    .in("send_status", ["pending", "failed"])
    .select(SELECT);
  if (error) throw error;
  const row = data?.[0] as unknown as (Omit<ClaimedRow, "dm_threads"> & { dm_threads: ClaimedRow["dm_threads"] | ClaimedRow["dm_threads"][] }) | undefined;
  if (!row) return null;
  return { ...row, dm_threads: Array.isArray(row.dm_threads) ? row.dm_threads[0]! : row.dm_threads };
}

const ALREADY_DONE: ActionResult = { summary: "処理済みのため何もしませんでした" };

async function setThread(id: number, fields: Record<string, unknown>): Promise<void> {
  const { error } = await db()
    .from("dm_threads")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** 送信して、送ったことを記録する（修正率ビューの元データになる out 行も作る） */
async function sendAndRecord(row: ClaimedRow, text: string, editedByHuman: boolean): Promise<void> {
  let eventId: string;
  try {
    eventId = await sendDm(row.dm_threads.x_conversation_id, text);
  } catch (e) {
    await db().from("dm_messages").update({ send_status: "failed" }).eq("id", row.id);
    throw e;
  }
  const now = new Date().toISOString();
  const results = await Promise.all([
    db()
      .from("dm_messages")
      .update({ final_reply: text, edited_by_human: editedByHuman, sent_at: now, send_status: "sent" })
      .eq("id", row.id),
    // ポーリングで同じイベントを拾っても x_event_id の一意制約で重複しない
    db().from("dm_messages").insert({
      x_event_id: eventId,
      thread_id: row.thread_id,
      direction: "out",
      body: text,
      category: row.category,
      edited_by_human: editedByHuman,
      sent_at: now,
      send_status: "sent",
    }),
  ]);
  for (const r of results) if (r.error) console.error("sendAndRecord: 記録に失敗（送信は完了済み）", r.error);
  await setThread(row.thread_id, { status: "replied" });
}

/** 送信をやめて、承認待ちに戻す */
async function releaseClaim(id: number): Promise<void> {
  await db().from("dm_messages").update({ send_status: "pending" }).eq("id", id);
}

/**
 * 送信直前の差し戻しチェック。止める理由を返す（空なら送ってよい）。
 * 返信案に「要修正」が残っているもの（デプロイ前に出た【DM承認】の［送信］ボタンを含む）と、
 * 実際に送る文面がルールに引っかかるものを止める。
 */
async function blockersFor(row: ClaimedRow, text: string, fromDraft: boolean): Promise<string[]> {
  const stored = fromDraft && isBlocked(row.needs_human_check)
    ? (row.needs_human_check ?? []).filter((c) => c.startsWith(BLOCK_PREFIX)).map((c) => c.slice(BLOCK_PREFIX.length))
    : [];
  const live = await sendBlockers(text);
  return [...new Set([...stored, ...live])];
}

export class SendBlockedError extends Error {
  constructor(readonly reasons: string[]) {
    super(`送信を止めました（要修正）。[修正して送信] から直してください: ${reasons.join(" / ")}`);
    this.name = "SendBlockedError";
  }
}

async function send(ctx: ActionContext, pick: (r: ClaimedRow) => string | null, label: string): Promise<ActionResult> {
  const row = await claim(parseId(ctx.value), "sending");
  if (!row) return ALREADY_DONE;
  const text = pick(row);
  if (!text) {
    await releaseClaim(row.id);
    throw new Error("送信する文面がありません。[修正して送信] から文面を入力してください");
  }
  const reasons = await blockersFor(row, text, true);
  if (reasons.length) {
    await releaseClaim(row.id);
    throw new SendBlockedError(reasons);
  }
  await sendAndRecord(row, text, false);
  return { summary: label };
}

async function skip(ctx: ActionContext, label: string): Promise<ActionResult> {
  const row = await claim(parseId(ctx.value), "skipped");
  if (!row) return ALREADY_DONE;
  await setThread(row.thread_id, { status: "closed" });
  return { summary: label };
}

async function leadOnly(ctx: ActionContext): Promise<ActionResult> {
  const row = await claim(parseId(ctx.value), "skipped");
  if (!row) return ALREADY_DONE;
  if (!row.classification) throw new Error("分類結果がないためリード登録できません");
  const leadId = await upsertLead({
    xUserId: row.dm_threads.x_user_id,
    username: row.dm_threads.x_username,
    displayName: row.dm_threads.x_name,
    classification: row.classification,
    source: "dm_poll",
  });
  await setThread(row.thread_id, { status: "closed", lead_id: leadId });
  return { summary: isLeadCategory(row.classification.category) ? "リードを更新しました（送信なし）" : "リード登録しました（送信なし）" };
}

export const EDIT_VIEW_ID = "dm_edit_submit";

/** [修正して送信]／[自分で書いて送信]: 返信案を初期値にしたモーダルを開く（trigger_id の期限内に同期で呼ぶ） */
async function openEditor(ctx: ActionContext): Promise<ActionResult> {
  const id = parseId(ctx.value);
  if (!ctx.triggerId) throw new Error("trigger_id がありません");
  const { data, error } = await db()
    .from("dm_messages")
    .select("draft_reply, decline_reply, send_status, classification")
    .eq("id", id)
    .single();
  if (error) throw error;
  if (!["pending", "failed"].includes(data.send_status)) return ALREADY_DONE;
  const category = (data.classification as Classification | null)?.category;
  const initial = (category === "sales_pitch" || category === "invitation" ? data.decline_reply : data.draft_reply) ?? "";
  await openModal(ctx.triggerId, {
    type: "modal",
    callback_id: EDIT_VIEW_ID,
    private_metadata: JSON.stringify({ id }),
    title: { type: "plain_text", text: "返信を編集" },
    submit: { type: "plain_text", text: "送信" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "reply",
        label: { type: "plain_text", text: "送信する文面" },
        element: {
          type: "plain_text_input",
          action_id: "reply_text",
          multiline: true,
          ...(initial ? { initial_value: initial } : {}),
        },
      },
    ],
  });
  return { summary: "", keepButtons: true };
}

/** モーダルの入力チェック（送信前にモーダル上で理由を返す）。問題なければ null */
export async function validateEdited(text: string): Promise<string | null> {
  const reasons = await sendBlockers(text.trim());
  return reasons.length ? `送信できません（要修正）: ${reasons.join(" / ")}` : null;
}

/** モーダルの [送信] */
export async function submitEdited(args: { userId: string; privateMetadata: string; text: string }): Promise<void> {
  const { id } = JSON.parse(args.privateMetadata) as { id: number };
  const row = await claim(id, "sending");
  if (!row) return;
  // 人が編集した本文でも、日程調整 URL があれば★の一文を付ける（消されていても戻す。二重にはしない）
  const text = appendMeetingNote(args.text.trim(), env().MEETING_URL) ?? "";
  // 念のため送信直前にもう一度チェックする（人が編集した本文も、自動の返信案と同じルール）
  const reasons = await blockersFor(row, text, false);
  if (reasons.length) {
    await releaseClaim(row.id);
    const view = await loadApprovalView(id);
    if (view.slackChannel && view.slackTs) {
      await postThreadReply({
        channel: view.slackChannel,
        threadTs: view.slackTs,
        text: `:warning: 送信を止めました（要修正）: ${reasons.join(" / ")}`,
      });
    }
    return;
  }
  const original = (row.category === "sales_pitch" || row.category === "invitation" ? row.decline_reply : row.draft_reply) ?? "";
  await sendAndRecord(row, text, text !== original.trim());
  const when = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  await markApprovalDone(id, `修正して送信しました（<@${args.userId}> / ${when}）`);
}

export const dmActionHandlers = {
  dm_send: (ctx: ActionContext) => send(ctx, (r) => r.draft_reply, "送信しました"),
  dm_decline: (ctx: ActionContext) => send(ctx, (r) => r.decline_reply, "お断りを送信しました"),
  dm_skip: (ctx: ActionContext) => skip(ctx, "送らない（クローズ）"),
  dm_lead_only: leadOnly,
};

export const dmSyncActionHandlers = {
  dm_edit: openEditor,
};
