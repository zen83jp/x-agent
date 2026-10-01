import { db } from "../supabase";
import type { XUser } from "../x/dm";
import { postApproval } from "./approval";
import { NO_DRAFT_CATEGORIES, classifyDm, draftReply } from "./generate";
import { isLeadCategory, upsertLead } from "./leads";
import type { DmContext } from "./schemas";
import { approvalModeFor } from "./slack";

const HISTORY_LIMIT = 10;

async function loadContext(messageId: number, threadId: number, sender: XUser | undefined): Promise<DmContext> {
  const [current, history] = await Promise.all([
    db().from("dm_messages").select("body").eq("id", messageId).single(),
    db()
      .from("dm_messages")
      .select("direction, body")
      .eq("thread_id", threadId)
      .lt("id", messageId)
      .order("id", { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);
  if (current.error) throw current.error;
  if (history.error) throw history.error;
  return {
    history: (history.data ?? []).reverse().map((m) => ({ from: m.direction === "out" ? "me" : "them", text: m.body })),
    newMessage: current.data.body,
    sender: { name: sender?.name, username: sender?.username, description: sender?.description },
  };
}

async function updateMessage(id: number, fields: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("dm_messages").update(fields).eq("id", id);
  if (error) throw error;
}

async function updateThread(id: number, fields: Record<string, unknown>): Promise<void> {
  const { error } = await db()
    .from("dm_threads")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/**
 * 相手から届いた DM（旧形式）を分類し、返信案を作って【DM承認】に回す。
 * 自動送信はしない（dm_auto_reply_enabled は Phase 5 まで false 運用）。
 */
export async function processIncoming(
  messageId: number,
  threadId: number,
  senderId: string,
  sender: XUser | undefined,
): Promise<void> {
  const ctx = await loadContext(messageId, threadId, sender);

  const classified = await classifyDm(ctx);
  if (!classified.ok) {
    await updateMessage(messageId, { needs_human_check: [`要手動対応: 分類に失敗しました（${classified.error}）`] });
    await updateThread(threadId, { status: "waiting_approval" });
    await postApproval(messageId);
    return;
  }
  const c = classified.data;
  await updateMessage(messageId, { category: c.category, confidence: c.confidence, classification: c });

  const reply = (NO_DRAFT_CATEGORIES as readonly string[]).includes(c.category) ? null : await draftReply(ctx, c);
  if (reply && !reply.ok) {
    await updateMessage(messageId, { needs_human_check: [`要手動対応: 返信案の作成に失敗しました（${reply.error}）`] });
  }
  const r = reply?.ok ? reply.data : null;
  if (r) {
    await updateMessage(messageId, {
      draft_reply: r.reply,
      decline_reply: r.decline_reply,
      needs_human_check: r.needs_human_check,
    });
  }

  if (isLeadCategory(c.category)) {
    const leadId = await upsertLead({
      xUserId: senderId,
      username: sender?.username,
      displayName: sender?.name,
      classification: c,
      note: r?.suggested_lead_note,
      source: "dm_poll",
    });
    await updateThread(threadId, { lead_id: leadId });
  }

  // 返信案の生成に失敗した場合は「要手動対応」として通知する（spam でも握りつぶさない）
  const mode = reply && !reply.ok ? "manual" : approvalModeFor(c.category, Boolean(r?.reply));
  if (mode === null) {
    // spam、または返信不要の挨拶: 通知せず close（ログのみ）
    await updateMessage(messageId, { send_status: "skipped" });
    await updateThread(threadId, { status: "closed", category: c.category });
    return;
  }
  await updateThread(threadId, { status: "waiting_approval", category: c.category });
  await postApproval(messageId);
}
