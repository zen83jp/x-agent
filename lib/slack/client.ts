import { WebClient, type KnownBlock } from "@slack/web-api";
import { env } from "../env";

let client: WebClient | undefined;

function slack(): WebClient {
  client ??= new WebClient(env().SLACK_BOT_TOKEN);
  return client;
}

/** 通知はすべて1つのチャンネルに送るため、先頭のラベルで種類を区別する */
export type MessageKind = "dm_approval" | "post_approval" | "alert";

const LABELS: Record<MessageKind, string> = {
  dm_approval: "【DM承認】",
  post_approval: "【投稿承認】",
  alert: "【アラート】",
};

/** text（通知・プレビュー用）と blocks（表示用）の両方の先頭にラベルを付ける */
export function withLabel(
  kind: MessageKind,
  text: string,
  blocks?: KnownBlock[],
): { text: string; blocks?: KnownBlock[] } {
  const label = LABELS[kind];
  return {
    text: `${label} ${text}`,
    blocks: blocks && [{ type: "context", elements: [{ type: "mrkdwn", text: `*${label}*` }] }, ...blocks],
  };
}

/**
 * 通知チャンネルに投稿する。返り値の channel と ts を保存しておき、後の更新（updateMessage）に使う。
 */
export async function postMessage(args: {
  kind: MessageKind;
  text: string;
  blocks?: KnownBlock[];
}): Promise<{ channel: string; ts: string }> {
  const res = await slack().chat.postMessage({
    channel: env().SLACK_CHANNEL_ID,
    ...withLabel(args.kind, args.text, args.blocks),
  });
  if (!res.ok || !res.ts || !res.channel) throw new Error(`Slack postMessage failed: ${res.error ?? "unknown"}`);
  return { channel: res.channel, ts: res.ts };
}

/** 既存メッセージのスレッドに返信する（ラベルなし） */
export async function postThreadReply(args: {
  channel: string;
  threadTs: string;
  text: string;
  blocks?: KnownBlock[];
}): Promise<void> {
  const res = await slack().chat.postMessage({
    channel: args.channel,
    thread_ts: args.threadTs,
    text: args.text,
    blocks: args.blocks,
  });
  if (!res.ok) throw new Error(`Slack thread reply failed: ${res.error ?? "unknown"}`);
}

export async function updateMessage(args: {
  channel: string;
  ts: string;
  text: string;
  blocks?: KnownBlock[];
}): Promise<void> {
  const res = await slack().chat.update({
    channel: args.channel,
    ts: args.ts,
    text: args.text,
    blocks: args.blocks ?? [],
  });
  if (!res.ok) throw new Error(`Slack update failed: ${res.error ?? "unknown"}`);
}

/**
 * 【アラート】の通知。アラート送信自体の失敗で本処理を止めないよう、例外は握りつぶしてログに出す。
 */
export async function notifyAlert(text: string, level: "error" | "info" = "error"): Promise<void> {
  const icon = level === "error" ? ":rotating_light:" : ":information_source:";
  try {
    await postMessage({ kind: "alert", text: `${icon} ${text}` });
  } catch (e) {
    console.error("notifyAlert failed", e, text);
  }
}

/** モーダルを開く。trigger_id はボタン押下から3秒で失効するので、押下を受けたリクエスト内で呼ぶこと */
export async function openModal(triggerId: string, view: Record<string, unknown>): Promise<void> {
  const res = await slack().views.open({ trigger_id: triggerId, view: view as never });
  if (!res.ok) throw new Error(`Slack views.open failed: ${res.error ?? "unknown"}`);
}

/** Slack にアップロードされたファイル（url_private_download）を取得する。files:read スコープが必要 */
export async function downloadSlackFile(url: string, maxBytes: number): Promise<Buffer> {
  if (!url.startsWith("https://files.slack.com/")) throw new Error("Slack 以外の URL は取得しません");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env().SLACK_BOT_TOKEN}` } });
  if (!res.ok) throw new Error(`Slack ファイルの取得に失敗: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`ファイルが大きすぎます（${buf.length} bytes）`);
  return buf;
}

export type SlackFile = { mimetype?: string; url_private_download?: string; size?: number; name?: string };

/** チャンネル直下のメッセージを1件取得する（添付ファイルの情報を確実に得るため）。history スコープが必要 */
export async function fetchChannelMessage(
  channel: string,
  ts: string,
): Promise<{ text?: string; files?: SlackFile[] } | null> {
  const res = await slack().conversations.history({ channel, latest: ts, inclusive: true, limit: 1 });
  if (!res.ok) throw new Error(`Slack conversations.history failed: ${res.error ?? "unknown"}`);
  const m = res.messages?.[0];
  return m && m.ts === ts ? { text: m.text, files: m.files as SlackFile[] | undefined } : null;
}
