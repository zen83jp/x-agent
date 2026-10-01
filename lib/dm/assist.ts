import type Anthropic from "@anthropic-ai/sdk";
import { generateJson, loadPrompt } from "../claude";
import { downloadSlackFile, fetchChannelMessage, postThreadReply, type SlackFile } from "../slack/client";
import { db } from "../supabase";
import { NO_DRAFT_CATEGORIES, classifyDm, draftReply, replyTextFor } from "./generate";
import { isLeadCategory, normalizeUsername, upsertLead } from "./leads";
import { screenshotSchema, type Classification, type DmContext, type Reply, type Screenshot } from "./schemas";
import { esc } from "./slack";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 5;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const USAGE =
  "使い方: `@X Agent` に続けて DM の本文を貼るか、DM 画面のスクショを添付してください。返信案ができたら、このスレッドで「もっと短く」などと返信すると作り直します。";

/** メンション（<@U…>）を取り除いた本文 */
export function stripMentions(text: string | undefined): string {
  return (text ?? "").replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, "").trim();
}

export function imageFiles(files: SlackFile[] | undefined): (SlackFile & { mimetype: ImageType; url_private_download: string })[] {
  return (files ?? []).filter(
    (f): f is SlackFile & { mimetype: ImageType; url_private_download: string } =>
      IMAGE_TYPES.includes(f.mimetype as ImageType) && Boolean(f.url_private_download),
  );
}

/**
 * スクショの読み取り結果を分類・返信案の入力にする。
 * 最後の相手の発言と、その直前に続いている相手の発言をまとめて「新着」とし、それより前を履歴にする。
 * （最後の相手の発言の後にある自分の発言は、まだ返していない返信の書きかけ等とみなして使わない）
 */
export function contextFromScreenshot(shot: Screenshot, note: string | null): DmContext | null {
  const msgs = shot.messages.filter((m) => m.text.trim());
  const lastThem = msgs.map((m) => m.from).lastIndexOf("them");
  if (lastThem < 0) return null;
  let start = lastThem;
  while (start > 0 && msgs[start - 1]!.from === "them") start--;
  return {
    history: msgs.slice(0, start),
    newMessage: msgs
      .slice(start, lastThem + 1)
      .map((m) => m.text)
      .join("\n"),
    sender: { name: shot.counterpart_name, username: normalizeUsername(shot.counterpart_username) },
    note,
  };
}

async function readScreenshots(files: ReturnType<typeof imageFiles>): Promise<Screenshot | string> {
  const images: Anthropic.ContentBlockParam[] = [];
  for (const f of files.slice(0, MAX_IMAGES)) {
    const buf = await downloadSlackFile(f.url_private_download, MAX_IMAGE_BYTES);
    images.push({ type: "image", source: { type: "base64", media_type: f.mimetype, data: buf.toString("base64") } });
  }
  const res = await generateJson({
    system: await loadPrompt("dm_screenshot_reader"),
    user: [...images, { type: "text", text: "このスクリーンショットの DM 会話を書き起こしてください。" }],
    schema: screenshotSchema,
    maxTokens: 4096,
  });
  return res.ok ? res.data : `スクショの読み取りに失敗しました（${res.error}）`;
}

const isDecline = (c: Classification) => c.category === "sales_pitch" || c.category === "invitation";

/** 返信案として表示する文面（営業・招待はお断り文） */
export const pickReplyText = replyTextFor;

export function buildSummary(args: {
  ctx: DmContext;
  classification: Classification;
  replyText: string | null;
  checks: string[];
  lead: "created_or_updated" | "none";
}): string {
  const { ctx, classification: c } = args;
  const who = [ctx.sender.name, ctx.sender.username && `@${ctx.sender.username}`].filter(Boolean).join(" ") || "（読み取れず）";
  const lines = [
    `*相手*: ${esc(who)}`,
    `*分類*: ${c.category}（確度 ${c.confidence.toFixed(2)}）— ${esc(c.reason)}`,
  ];
  if (args.lead === "created_or_updated") lines.push("*リード*: 登録／更新しました");
  if (args.checks.length) lines.push(`*要確認*\n${args.checks.map((x) => `• ${esc(x)}`).join("\n")}`);
  if (args.replyText) {
    lines.push(isDecline(c) ? "↓ お断り文（コピーして X アプリから送信）" : "↓ 返信案（コピーして X アプリから送信）");
  } else if (c.category === "escalate") {
    lines.push("返信案は作っていません。内容を確認のうえ、ご自身で対応してください。");
  } else {
    lines.push("返信は不要と判断しました。");
  }
  return lines.join("\n");
}

/** 返信案だけを本文にしたメッセージ（装飾なし。長押し・選択でそのままコピーできるように） */
function copyable(text: string): { text: string; mrkdwn: false } {
  // plain_text のブロックだと改行がスペースで表示されることがあるため、書式なしの本文として送る
  return { text, mrkdwn: false };
}

/** ② 返信アシスタント: メンションされたメッセージから分類と返信案を作ってスレッドに返す */
export async function startAssist(args: {
  channel: string;
  rootTs: string;
  messageTs: string;
  text?: string;
  files?: SlackFile[];
}): Promise<void> {
  // 添付が event に含まれない場合に備えて、チャンネル直下のメッセージは取り直す
  const fetched = args.files?.length || args.rootTs !== args.messageTs ? null : await fetchChannelMessage(args.channel, args.messageTs);
  const files = imageFiles(args.files?.length ? args.files : fetched?.files);
  const text = stripMentions(args.text ?? fetched?.text);

  // slack_ts の一意制約で二重処理を防ぐ（Slack の再送、app_mention と message の両方で届く場合）
  const { data: row, error } = await db()
    .from("dm_assists")
    .insert({ slack_channel: args.channel, slack_ts: args.rootTs, input_type: files.length ? "image" : "text" })
    .select("id")
    .single();
  if (error?.code === "23505") return;
  if (error) throw error;

  const say = (t: string) => postThreadReply({ channel: args.channel, threadTs: args.rootTs, text: t });
  try {
    let ctx: DmContext | null;
    let shot: Screenshot | null = null;
    if (files.length) {
      const read = await readScreenshots(files);
      if (typeof read === "string") return void (await say(`:warning: ${read}`));
      shot = read;
      ctx = shot.readable ? contextFromScreenshot(shot, text || null) : null;
      await db().from("dm_assists").update({ extracted: { screenshot: shot } }).eq("id", row.id);
      if (!ctx) return void (await say(":warning: スクショから相手のメッセージを読み取れませんでした。本文をテキストで貼ってください。"));
    } else if (text) {
      ctx = { history: [], newMessage: text, sender: {} };
    } else {
      return void (await say(USAGE));
    }

    const classified = await classifyDm(ctx);
    if (!classified.ok) return void (await say(`:warning: 分類に失敗しました（${classified.error}）`));
    const c = classified.data;

    const drafted = (NO_DRAFT_CATEGORIES as readonly string[]).includes(c.category) ? null : await draftReply(ctx, c);
    if (drafted && !drafted.ok) return void (await say(`:warning: 返信案の作成に失敗しました（${drafted.error}）`));
    const r = drafted?.ok ? drafted.data : null;

    let leadId: number | null = null;
    if (isLeadCategory(c.category)) {
      leadId = await upsertLead({
        username: ctx.sender.username,
        displayName: ctx.sender.name,
        classification: c,
        note: r?.suggested_lead_note,
        source: "slack_assist",
      });
    }

    const replyText = pickReplyText(c, r);
    await say(buildSummary({ ctx, classification: c, replyText, checks: r?.needs_human_check ?? [], lead: leadId ? "created_or_updated" : "none" }));
    if (replyText) await postThreadReply({ channel: args.channel, threadTs: args.rootTs, ...copyable(replyText) });

    await db()
      .from("dm_assists")
      .update({ extracted: { ...(shot ? { screenshot: shot } : {}), context: ctx }, classification: c, reply: r, lead_id: leadId })
      .eq("id", row.id);
  } catch (e) {
    console.error("startAssist failed", e);
    await say(`:warning: 処理中にエラーが発生しました（${e instanceof Error ? e.message : String(e)}）`);
  }
}

type AssistRow = {
  id: number;
  slack_channel: string;
  slack_ts: string;
  extracted: { context?: DmContext } | null;
  classification: Classification | null;
  reply: Reply | null;
};

export async function findAssist(rootTs: string): Promise<AssistRow | null> {
  const { data, error } = await db()
    .from("dm_assists")
    .select("id, slack_channel, slack_ts, extracted, classification, reply")
    .eq("slack_ts", rootTs)
    .maybeSingle();
  if (error) throw error;
  return data as AssistRow | null;
}

/** ② のスレッドで代表が返信した指示（「もっと短く」等）を反映して返信案を作り直す。指示は積み重ねる */
export async function reviseAssist(assist: AssistRow, messageTs: string, rawText: string | undefined): Promise<void> {
  const instruction = stripMentions(rawText);
  if (!instruction) return;

  const { data: rev, error } = await db()
    .from("dm_assist_revisions")
    .insert({ slack_ts: messageTs, assist_id: assist.id, instruction })
    .select("id")
    .single();
  if (error?.code === "23505") return;
  if (error) throw error;

  const say = (t: string) => postThreadReply({ channel: assist.slack_channel, threadTs: assist.slack_ts, text: t });
  try {
    const ctx = assist.extracted?.context;
    const c = assist.classification;
    const { data: history, error: hErr } = await db()
      .from("dm_assist_revisions")
      .select("id, instruction, reply")
      .eq("assist_id", assist.id)
      .order("id");
    if (hErr) throw hErr;
    const earlier = (history ?? []).filter((h) => h.id !== rev.id && h.reply);
    const previous = c ? pickReplyText(c, (earlier.at(-1)?.reply as Reply | undefined) ?? assist.reply) : null;
    if (!ctx || !c || !previous) return void (await say("作り直せる返信案がありません。"));

    const instructions = (history ?? []).filter((h) => h.id <= rev.id).map((h) => h.instruction);
    const drafted = await draftReply(ctx, c, { previousReply: previous, instructions });
    if (!drafted.ok) return void (await say(`:warning: 作り直しに失敗しました（${drafted.error}）`));
    const text = pickReplyText(c, drafted.data);
    if (!text) return void (await say("指示を反映すると返信は不要と判断されました。"));

    const checks = drafted.data.needs_human_check;
    await say(
      [`指示を反映しました（${instructions.length}回目）`, ...(checks.length ? [`*要確認*\n${checks.map((x) => `• ${esc(x)}`).join("\n")}`] : [])].join("\n"),
    );
    await postThreadReply({ channel: assist.slack_channel, threadTs: assist.slack_ts, ...copyable(text) });
    await db().from("dm_assist_revisions").update({ reply: drafted.data }).eq("id", rev.id);
  } catch (e) {
    console.error("reviseAssist failed", e);
    await say(`:warning: 作り直し中にエラーが発生しました（${e instanceof Error ? e.message : String(e)}）`);
  }
}
