import type { KnownBlock } from "@slack/web-api";
import { after, NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  actionHandlers,
  blockActionsPayload,
  syncActionHandlers,
  viewHandlers,
  viewSubmissionPayload,
  type BlockActionsPayload,
  type ViewSubmissionPayload,
} from "@/lib/slack/actions";
import { notifyAlert, postThreadReply, updateMessage } from "@/lib/slack/client";
import { verifySlackSignature } from "@/lib/slack/verify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Slack のボタン操作・モーダル送信を受ける。Slack は3秒以内の応答を求めるので、署名検証とパースだけ同期で行い、
 * 実処理は after() でレスポンス後に実行する（モーダルを開く操作だけは trigger_id の期限があるため同期）。
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

  const view = viewSubmissionPayload.safeParse(raw);
  if (view.success) return handleViewSubmission(view.data);

  const parsed = blockActionsPayload.safeParse(raw);
  // 未対応の種類は Slack にエラーを返さない
  if (!parsed.success) return new NextResponse(null, { status: 200 });
  // 通知チャンネル以外からの操作は受け付けない
  if (parsed.data.container.channel_id !== env().SLACK_CHANNEL_ID) {
    console.warn("action from unexpected channel", parsed.data.container.channel_id);
    return new NextResponse(null, { status: 200 });
  }

  const actionId = parsed.data.actions[0]!.action_id;
  if (syncActionHandlers[actionId]) {
    await handle(parsed.data, syncActionHandlers[actionId]);
    return new NextResponse(null, { status: 200 });
  }
  after(() => handle(parsed.data, actionHandlers[actionId]));
  return new NextResponse(null, { status: 200 });
}

function handleViewSubmission(p: ViewSubmissionPayload): Response {
  const entry = viewHandlers[p.view.callback_id];
  if (!entry) return new NextResponse(null, { status: 200 });
  const text = p.view.state.values[entry.block]?.[entry.action]?.value?.trim() ?? "";
  if (!text) {
    // モーダルを閉じずに入力欄にエラーを表示する
    return NextResponse.json({ response_action: "errors", errors: { [entry.block]: "文面を入力してください" } });
  }
  after(async () => {
    try {
      await entry.handler({ userId: p.user.id, privateMetadata: p.view.private_metadata, text });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("view submission failed", p.view.callback_id, e);
      await notifyAlert(`モーダルからの送信に失敗しました（要手動対応）: ${msg}`);
    }
  });
  return new NextResponse(null, { status: 200 }); // 空の 200 でモーダルを閉じる
}

async function handle(p: BlockActionsPayload, handler: (typeof actionHandlers)[string] | undefined): Promise<void> {
  const action = p.actions[0]!;
  const channel = p.container.channel_id;
  const messageTs = p.container.message_ts;

  try {
    if (!handler) throw new Error(`未登録の action_id: ${action.action_id}`);
    const result = await handler({ userId: p.user.id, value: action.value, channel, messageTs, triggerId: p.trigger_id });
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
