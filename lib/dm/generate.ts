import { generateJson, loadPrompt, type JsonResult } from "../claude";
import { env } from "../env";
import { db } from "../supabase";
import { BLOCK_PREFIX, blockingIssues } from "./rules";
import { classificationSchema, replySchema, type Classification, type DmContext, type Reply } from "./schemas";

const MAX_REPLY_CHARS = 200;
const URL_IN_TEXT = /https?:\/\/[^\s<>「」（）()]+/g;

/** 返信案を作らないカテゴリ（dm_reply.md の方針どおり reply は null） */
export const NO_DRAFT_CATEGORIES = ["spam", "escalate"] as const;

function formatHistory(history: DmContext["history"]): string {
  return history.map((m) => `[${m.from === "me" ? "自分" : "相手"}] ${m.text}`).join("\n");
}

function formatSender(sender: DmContext["sender"]): string {
  return [
    sender.name && `表示名: ${sender.name}`,
    sender.username && `ユーザー名: @${sender.username}`,
    sender.description && `bio: ${sender.description}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function noteBlock(ctx: DmContext): string {
  return ctx.note ? `\n<operator_note>\n${ctx.note}\n</operator_note>` : "";
}

export function clampConfidence(c: Classification): Classification {
  return { ...c, confidence: Math.min(1, Math.max(0, c.confidence)) };
}

export async function classifyDm(ctx: DmContext): Promise<JsonResult<Classification>> {
  const user = [
    `<thread_history>\n${formatHistory(ctx.history)}\n</thread_history>`,
    `<new_message>\n${ctx.newMessage}\n</new_message>`,
    `<sender_profile>\n${formatSender(ctx.sender)}\n</sender_profile>`,
  ].join("\n") + noteBlock(ctx);
  const res = await generateJson({ system: await loadPrompt("dm_classifier"), user, schema: classificationSchema, maxTokens: 2048 });
  return res.ok ? { ok: true, data: clampConfidence(res.data) } : res;
}

type Faq = { id: number; question: string; answer: string };

async function loadReplyInputs(): Promise<{ styleGuide: string; faqs: Faq[] }> {
  const [style, faq] = await Promise.all([
    db().from("style_guide").select("content").eq("approved", true).order("version", { ascending: false }).limit(1),
    db().from("faq").select("id, question, answer").eq("active", true).order("id"),
  ]);
  if (faq.error) throw faq.error;
  return {
    styleGuide: style.data?.[0]?.content ?? "（未整備。プロンプトの仮ルールに従う）",
    faqs: faq.data ?? [],
  };
}

export type Revision = { previousReply: string; instructions: string[] };


export async function draftReply(
  ctx: DmContext,
  classification: Classification,
  revision?: Revision,
): Promise<JsonResult<Reply>> {
  const { styleGuide, faqs } = await loadReplyInputs();
  const parts = [
    `<style_guide>\n${styleGuide}\n</style_guide>`,
    `<faq>\n${faqs.map((f) => `[${f.id}] Q: ${f.question}\nA: ${f.answer}`).join("\n\n")}\n</faq>`,
    `<classification>\n${JSON.stringify(classification)}\n</classification>`,
    `<thread_history>\n${formatHistory(ctx.history)}\n</thread_history>`,
    `<new_message>\n${ctx.newMessage}\n</new_message>`,
    `<meeting_url>${env().MEETING_URL}</meeting_url>`,
    `<first_reply>${ctx.firstReply ? "true" : "false"}</first_reply>`,
  ];
  if (revision) {
    parts.push(
      `<previous_reply>\n${revision.previousReply}\n</previous_reply>`,
      `<revision_instructions>\n${revision.instructions.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n</revision_instructions>`,
    );
  }
  // 作り直しのルールも dm_reply.md に書いてある（<revision_instructions> があるとき）
  const system = await loadPrompt("dm_reply");
  const meetingUrl = env().MEETING_URL;
  const allowed = allowedUrls(meetingUrl, faqs);
  const generate = (extra: string[]) =>
    generateJson({ system, user: [...parts, ...extra].join("\n") + noteBlock(ctx), schema: replySchema, maxTokens: 4096 });
  const blockingOf = (r: Reply) => [
    ...blockingIssues(r.reply, allowed),
    ...blockingIssues(r.decline_reply, allowed).map((c) => `お断り文: ${c}`),
  ];

  let res = await generate([]);
  if (!res.ok) return res;
  let blocking = blockingOf(res.data);
  // 差し戻し: 理由を添えて1回だけ作り直す。それでも残れば「要修正」として［送信］を出さない
  if (blocking.length) {
    const retry = await generate([
      `<rejected_reply>\n${replyTextFor(classification, res.data) ?? ""}\n</rejected_reply>`,
      `<rejection_reasons>\n${blocking.map((b) => `- ${b}`).join("\n")}\n</rejection_reasons>`,
    ]);
    if (retry.ok) {
      res = retry;
      blocking = blockingOf(retry.data);
    }
  }

  const checks = [
    ...blocking.map((b) => `${BLOCK_PREFIX}${b}`),
    ...res.data.needs_human_check,
    ...checkReplyText(res.data.reply, allowed, meetingUrl),
    ...checkReplyText(res.data.decline_reply, allowed, meetingUrl).map((c) => `お断り文: ${c}`),
    ...(revision ? checkShortened(revision, replyTextFor(classification, res.data), meetingUrl) : []),
  ];
  return { ok: true, data: { ...res.data, needs_human_check: checks } };
}

/**
 * 送信直前のチェック（［送信］［丁寧に断る］［修正して送信］のすべて）。差し戻しの理由を返す（空なら送ってよい）。
 * 返信案の生成時と同じルールを、実際に送る文面にかける。
 */
export async function sendBlockers(text: string): Promise<string[]> {
  const { data, error } = await db().from("faq").select("answer").eq("active", true);
  if (error) throw error;
  return blockingIssues(text, allowedUrls(env().MEETING_URL, data ?? []));
}

/** 表示・送信する文面（営業・招待はお断り文、それ以外は返信案） */
export function replyTextFor(c: Classification, r: Reply | null): string | null {
  if (!r) return null;
  return c.category === "sales_pitch" || c.category === "invitation" ? r.decline_reply : r.reply;
}

const SHORTEN_REQUEST = /短く|短縮|簡潔|コンパクト|削って|減らして|縮めて/;

/** 短縮の指示（最新の指示）なのに、本文が前の案より短くなっていなければ要確認にする */
export function checkShortened(revision: Revision, newText: string | null, meetingUrl: string): string[] {
  const latest = revision.instructions.at(-1) ?? "";
  if (!newText || !SHORTEN_REQUEST.test(latest)) return [];
  const before = countBodyChars(revision.previousReply, meetingUrl);
  const after = countBodyChars(newText, meetingUrl);
  return after < before ? [] : [`短縮の指示でしたが、本文が前の案より短くなっていません（${before}字 → ${after}字）`];
}

export function allowedUrls(meetingUrl: string, faqs: Pick<Faq, "answer">[]): string[] {
  return [meetingUrl, ...faqs.flatMap((f) => f.answer.match(URL_IN_TEXT) ?? [])];
}

const MEETING_LEAD = "▼日程調整";
/** お礼／本題／面談の誘い。文がこれ以上あるのに本文の行数が足りなければ「改行が足りない」 */
const MIN_BODY_LINES = 3;
/** 言いさし（文が完結していない）とみなす文末 */
const TRAILING_OFF = /(れば|たら|ので|けど|けれど)[。！!]?$/;

function isBoilerplateLine(line: string, meetingUrl: string): boolean {
  const t = line.trim();
  return t.startsWith(MEETING_LEAD) || t === meetingUrl;
}

/**
 * 字数制限の対象になる本文の文字数。▼日程調整の定型文の行と日程調整 URL の行、改行は数えない
 * （dm_reply.md の「本文は200字以内」と同じ数え方）。
 */
export function countBodyChars(text: string, meetingUrl: string): number {
  return [...text.split("\n").filter((l) => !isBoilerplateLine(l, meetingUrl)).join("")].length;
}

/**
 * 返信案の機械チェック（文面の体裁）。問題は「要確認」として表示するだけで、送信は止めない。
 * 送信を止めるルール（割引表現・税抜・途中解約不可・自動更新・通常5営業日・許可外 URL）は rules.ts の blockingIssues
 */
export function checkReplyText(text: string | null, allowed: string[], meetingUrl: string): string[] {
  if (!text) return [];
  const issues: string[] = [];
  const length = countBodyChars(text, meetingUrl);
  if (length > MAX_REPLY_CHARS) issues.push(`本文が${MAX_REPLY_CHARS}字を超えています（${length}字。日程調整の定型文と URL を除く）`);
  const lines = text.split("\n").map((l) => l.trim());
  if (text.includes(meetingUrl) && !lines.includes(meetingUrl)) issues.push("日程調整 URL が独立した行になっていません");
  if (text.includes(MEETING_LEAD) && !lines.some((l) => l.startsWith(MEETING_LEAD))) {
    issues.push("「▼日程調整…」の定型文が独立した行になっていません");
  }
  const body = lines.filter((l) => l && !isBoilerplateLine(l, meetingUrl));
  const sentences = (body.join("").match(/[。！!？?]/g) ?? []).length;
  if (body.length < Math.min(MIN_BODY_LINES, sentences)) {
    issues.push("改行が足りません（お礼／本題／面談の誘いをそれぞれ別の行にしてください）");
  }
  const trailing = lines.filter((l) => !isBoilerplateLine(l, meetingUrl) && TRAILING_OFF.test(l));
  if (trailing.length) issues.push(`文が言いさしで終わっています: 「${trailing[0]}」`);
  const nested = text.match(/（[^（）]*（[^（）]*）/);
  if (nested) issues.push(`括弧の中に括弧があります（「${nested[0]}…」）。要素は「／」で区切ってください`);
  return issues;
}
