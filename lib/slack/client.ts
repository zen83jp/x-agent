import { WebClient, type KnownBlock } from "@slack/web-api";
import { env } from "../env";

let client: WebClient | undefined;

function slack(): WebClient {
  client ??= new WebClient(env().SLACK_BOT_TOKEN);
  return client;
}

export async function postMessage(args: {
  channel: string;
  text: string;
  blocks?: KnownBlock[];
  threadTs?: string;
}): Promise<{ ts: string }> {
  const res = await slack().chat.postMessage({
    channel: args.channel,
    text: args.text,
    blocks: args.blocks,
    thread_ts: args.threadTs,
  });
  if (!res.ok || !res.ts) throw new Error(`Slack postMessage failed: ${res.error ?? "unknown"}`);
  return { ts: res.ts };
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
 * アラートチャンネルへの通知。アラート送信自体の失敗で本処理を止めないよう、例外は握りつぶしてログに出す。
 */
export async function notifyAlert(text: string, level: "error" | "info" = "error"): Promise<void> {
  const icon = level === "error" ? ":rotating_light:" : ":information_source:";
  try {
    await postMessage({ channel: env().SLACK_CHANNEL_ALERTS, text: `${icon} ${text}` });
  } catch (e) {
    console.error("notifyAlert failed", e, text);
  }
}
