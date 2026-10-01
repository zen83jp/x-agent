import type { KnownBlock } from "@slack/web-api";
import { after, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { actionHandlers, blockActionsPayload, type BlockActionsPayload } from "@/lib/slack/actions";
import { notifyAlert, postThreadReply, updateMessage } from "@/lib/slack/client";
import { verifySlackSignature } from "@/lib/slack/verify";

export const dynamic = "force-dynamic";

/**
 * Slack のボタン操作を受ける。Slack は3秒以内の応答を求めるので、署名検証とパースだけ同期で行い、
 * 実処理は after() でレスポンス後に実行する。
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const ok = verifySlackSignature({
    signingSecret: env().SLACK_SIGNING_SECRET,
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
  });
  if (!ok) return new NextResponse("invalid signature", { status: 401 });

  const payloadJson = new URLSearchParams(rawBody).get("payload");
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson ?? "");
  } catch {
    return new NextResponse("bad payload", { status: 400 });
  }
  const parsed = blockActionsPayload.safeParse(raw);
  // block_actions 以外（モーダル送信など）は Phase 2 以降で対応。Slack にはエラーを返さない
  if (!parsed.success) return new NextResponse(null, { status: 200 });
  // 通知チャンネル以外からの操作は受け付けない
  if (parsed.data.container.channel_id !== env().SLACK_CHANNEL_ID) {
    console.warn("action from unexpected channel", parsed.data.container.channel_id);
    return new NextResponse(null, { status: 200 });
  }

  after(() => handle(parsed.data));
  return new NextResponse(null, { status: 200 });
}

async function handle(p: BlockActionsPayload): Promise<void> {
  const action = p.actions[0]!;
  const channel = p.container.channel_id;
  const messageTs = p.container.message_ts;
  const handler = actionHandlers[action.action_id];

  try {
    if (!handler) throw new Error(`未登録の action_id: ${action.action_id}`);
    const result = await handler({ userId: p.user.id, value: action.value, channel, messageTs });
    if (result.keepButtons) return;

    // ボタン（actions ブロック）を外し、誰がいつ何をしたかを残す（二重押下の防止）
    const blocks = ((p.message?.blocks ?? []) as unknown as KnownBlock[]).filter((b) => b.type !== "actions");
    const when = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `:white_check_mark: ${result.summary}（<@${p.user.id}> / ${when}）` }],
    });
    await updateMessage({ channel, ts: messageTs, text: p.message?.text ?? result.summary, blocks });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("slack action failed", action.action_id, e);
    await postThreadReply({ channel, threadTs: messageTs, text: `:warning: 要手動対応: ${msg}` }).catch(() =>
      notifyAlert(`Slack アクション ${action.action_id} の処理に失敗: ${msg}`),
    );
  }
}
