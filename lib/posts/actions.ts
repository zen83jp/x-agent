import type { ActionContext, ActionHandler, ActionResult } from "../slack/actions";
import { db } from "../supabase";
import { refreshDraftApproval } from "./approval";
import { SLOTS, formatJst, nextSlotTime, type Slot } from "./slack";
import { releaseTopic } from "./topics";

function parseId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`不正な post_drafts.id: ${value}`);
  return id;
}

const ALREADY_DONE: ActionResult = { summary: "処理済みのため何もしませんでした" };

/**
 * 承認: 承認待ちの案だけを、選んだ時刻の次の発生時刻で予約する（条件付き更新で二重承認しない）。
 * 投稿するのは review_status = 'approved' の案だけ（CLAUDE.md の絶対ルール）。
 */
export async function approveDraft(id: number, slot: Slot, now = new Date()): Promise<ActionResult> {
  const at = nextSlotTime(slot, now);
  const { data, error } = await db()
    .from("post_drafts")
    .update({ review_status: "approved", scheduled_at: at.toISOString(), approved_at: now.toISOString() })
    .eq("id", id)
    .eq("review_status", "awaiting_approval")
    .select("id");
  if (error) throw error;
  if (!data?.length) return ALREADY_DONE;
  return { summary: `承認: ${formatJst(at)} に投稿予約` };
}

export async function rejectDraft(id: number): Promise<ActionResult> {
  const { data, error } = await db()
    .from("post_drafts")
    .update({ review_status: "rejected" })
    .eq("id", id)
    .eq("review_status", "awaiting_approval")
    .select("id, topic_id");
  if (error) throw error;
  if (!data?.length) return ALREADY_DONE;
  await releaseTopic(data[0]!.topic_id);
  return { summary: data[0]!.topic_id ? "却下（ネタはストックに戻しました）" : "却下" };
}

/** 承認・却下のあと、メッセージを DB から描き直してボタンと修正の案内を消す */
function withRefresh(run: (id: number) => Promise<ActionResult>): ActionHandler {
  return async (ctx: ActionContext) => {
    const id = parseId(ctx.value);
    const result = await run(id);
    if (result === ALREADY_DONE) return result;
    const when = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    await refreshDraftApproval(id, `:white_check_mark: ${result.summary}（<@${ctx.userId}> / ${when}）`);
    return { ...result, keepButtons: true };
  };
}

export const postActionHandlers: Record<string, ActionHandler> = {
  ...Object.fromEntries(SLOTS.map((slot) => [`post_approve_${slot.replace(":", "")}`, withRefresh((id) => approveDraft(id, slot))])),
  post_reject: withRefresh(rejectDraft),
};
