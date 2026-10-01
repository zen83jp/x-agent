import { postMessage, updateMessage, withLabel } from "../slack/client";
import { db } from "../supabase";
import type { Classification } from "./schemas";
import { approvalModeFor, buildApprovalBlocks, type ApprovalView } from "./slack";

/**
 * dm_messages の1行から【DM承認】メッセージを組み立てる。
 * Slack の表示は常に DB から作り直す（モーダル経由の送信でも元の表示を再現できるように）。
 */
export async function loadApprovalView(messageId: number, done?: string | null): Promise<ApprovalView & {
  slackChannel: string | null;
  slackTs: string | null;
}> {
  const { data: m, error } = await db()
    .from("dm_messages")
    .select("id, body, classification, draft_reply, decline_reply, needs_human_check, slack_channel, slack_ts, dm_threads(x_name, x_username)")
    .eq("id", messageId)
    .single();
  if (error) throw error;
  const thread = (Array.isArray(m.dm_threads) ? m.dm_threads[0] : m.dm_threads) as
    | { x_name: string | null; x_username: string | null }
    | null;
  const classification = (m.classification as Classification | null) ?? null;
  const checks = (m.needs_human_check as string[] | null) ?? [];
  const failure = checks.find((c) => c.startsWith("要手動対応:"))?.replace("要手動対応:", "").trim() ?? null;
  return {
    messageId: m.id,
    mode: approvalModeFor(classification?.category ?? null, Boolean(m.draft_reply)) ?? "manual",
    sender: { name: thread?.x_name, username: thread?.x_username },
    body: m.body,
    classification,
    draft: m.draft_reply,
    declineReply: m.decline_reply,
    checks: checks.filter((c) => !c.startsWith("要手動対応:")),
    failure,
    done: done ?? null,
    slackChannel: m.slack_channel,
    slackTs: m.slack_ts,
  };
}

/** 【DM承認】を投稿し、返ってきたチャンネル ID と ts を保存する */
export async function postApproval(messageId: number): Promise<void> {
  const view = await loadApprovalView(messageId);
  const { channel, ts } = await postMessage({ kind: "dm_approval", ...buildApprovalBlocks(view) });
  const { error } = await db().from("dm_messages").update({ slack_channel: channel, slack_ts: ts }).eq("id", messageId);
  if (error) throw error;
}

/** 保存しておいたチャンネル ID と ts で、承認メッセージを「処理済み」表示に更新する */
export async function markApprovalDone(messageId: number, done: string): Promise<void> {
  const view = await loadApprovalView(messageId, done);
  if (!view.slackChannel || !view.slackTs) return;
  const { text, blocks } = buildApprovalBlocks(view);
  // 投稿時と同じく【DM承認】ラベルを付け直す
  await updateMessage({ channel: view.slackChannel, ts: view.slackTs, ...withLabel("dm_approval", text, blocks) });
}
