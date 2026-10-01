import { after, NextResponse } from "next/server";
import { z } from "zod";
import { findAssist, reviseAssist, startAssist } from "@/lib/dm/assist";
import { env } from "@/lib/env";
import { notifyAlert } from "@/lib/slack/client";
import { isTargetEvent } from "@/lib/slack/events";
import { verifySlackSignature } from "@/lib/slack/verify";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const fileSchema = z.object({
  mimetype: z.string().optional(),
  url_private_download: z.string().optional(),
  size: z.number().optional(),
  name: z.string().optional(),
});

const eventSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().optional(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  channel: z.string(),
  files: z.array(fileSchema).optional(),
});

const bodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url_verification"), challenge: z.string() }),
  z.object({ type: z.literal("event_callback"), event: eventSchema }),
]);

type SlackEvent = z.infer<typeof eventSchema>;

/**
 * Slack Events API。暗号化 DM の返信アシスタント（②）の入口。
 * - app_mention: 新しい依頼（本文テキスト or スクショ）
 * - message（スレッド返信）: 返信アシスタントのスレッド内での作り直し指示
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

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return new NextResponse("bad payload", { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return new NextResponse(null, { status: 200 });
  if (parsed.data.type === "url_verification") return NextResponse.json({ challenge: parsed.data.challenge });

  // 初回は3秒以内に 200 を返して after() で処理しているので、Slack の再送は処理しない
  if (req.headers.get("x-slack-retry-num")) return new NextResponse(null, { status: 200 });

  const event = parsed.data.event;
  after(() => route(event));
  return new NextResponse(null, { status: 200 });
}

async function route(e: SlackEvent): Promise<void> {
  try {
    if (!isTargetEvent(e, env().SLACK_CHANNEL_ID)) return;
    const inThread = Boolean(e.thread_ts && e.thread_ts !== e.ts);

    if (inThread) {
      const assist = await findAssist(e.thread_ts!);
      // 返信アシスタントのスレッド内 → 作り直し（メンションの有無を問わず、ts で1回に絞られる）
      if (assist) return await reviseAssist(assist, e.ts, e.text);
      // ほかのスレッドでメンションされた → そのスレッドで新しい依頼として扱う
      if (e.type === "app_mention") {
        return await startAssist({ channel: e.channel, rootTs: e.thread_ts!, messageTs: e.ts, text: e.text, files: e.files });
      }
      return;
    }
    // チャンネル直下はメンションされたものだけ
    if (e.type === "app_mention") {
      await startAssist({ channel: e.channel, rootTs: e.ts, messageTs: e.ts, text: e.text, files: e.files });
    }
  } catch (err) {
    console.error("slack event failed", err);
    await notifyAlert(`返信アシスタントの処理に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  }
}
