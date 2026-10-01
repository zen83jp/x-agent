import { generateJson, loadPrompt, type JsonResult } from "../claude";
import { env } from "../env";
import { db } from "../supabase";
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

const REVISION_RULE = `

## 書き直し
<revision_instructions> がある場合は、<previous_reply> を、そこに並んだ指示（古い順。すべて守る）に従って書き直す。
指示と「絶対ルール」がぶつかる場合は絶対ルールを優先し、守れなかった点を needs_human_check に書く。`;

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
  ];
  if (revision) {
    parts.push(
      `<previous_reply>\n${revision.previousReply}\n</previous_reply>`,
      `<revision_instructions>\n${revision.instructions.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n</revision_instructions>`,
    );
  }
  const system = (await loadPrompt("dm_reply")) + (revision ? REVISION_RULE : "");
  const res = await generateJson({ system, user: parts.join("\n") + noteBlock(ctx), schema: replySchema, maxTokens: 4096 });
  if (!res.ok) return res;
  const allowed = allowedUrls(env().MEETING_URL, faqs);
  const checks = [
    ...res.data.needs_human_check,
    ...checkReplyText(res.data.reply, allowed),
    ...checkReplyText(res.data.decline_reply, allowed).map((c) => `お断り文: ${c}`),
  ];
  return { ok: true, data: { ...res.data, needs_human_check: checks } };
}

export function allowedUrls(meetingUrl: string, faqs: Pick<Faq, "answer">[]): string[] {
  return [meetingUrl, ...faqs.flatMap((f) => f.answer.match(URL_IN_TEXT) ?? [])];
}

/** 返信案の機械チェック。問題は「要確認」として表示するだけで、送信は止めない */
export function checkReplyText(text: string | null, allowed: string[]): string[] {
  if (!text) return [];
  const issues: string[] = [];
  const length = [...text].length;
  if (length > MAX_REPLY_CHARS) issues.push(`${MAX_REPLY_CHARS}字を超えています（${length}字）`);
  for (const url of text.match(URL_IN_TEXT) ?? []) {
    if (!allowed.some((a) => url.startsWith(a))) issues.push(`許可されていない URL が含まれています: ${url}`);
  }
  return issues;
}
