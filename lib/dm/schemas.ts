import { z } from "zod";

/**
 * prompts/*.md の出力形式に対応する zod スキーマ。
 * Structured Outputs に渡すため、数値の範囲などの制約はスキーマに書かず、受け取った後に丸める。
 */

export const CATEGORIES = [
  "spam",
  "sales_pitch",
  "invitation",
  "greeting",
  "worker_application",
  "other",
  "faq",
  "inquiry_detailed",
  "quote_contract",
  "escalate",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const classificationSchema = z.object({
  category: z.enum(CATEGORIES),
  confidence: z.number(),
  reason: z.string(),
  company: z.string().nullable(),
  need: z.string().nullable(),
  urgency: z.enum(["high", "normal", "low"]),
  meeting_intent: z.boolean(),
  flags: z.array(z.enum(["personal_info", "competitor", "negative_tone", "contains_url"])),
});
export type Classification = z.infer<typeof classificationSchema>;

export const replySchema = z.object({
  reply: z.string().nullable(),
  uses_faq_ids: z.array(z.number()),
  needs_human_check: z.array(z.string()),
  suggested_lead_note: z.string().nullable(),
  decline_reply: z.string().nullable(),
});
export type Reply = z.infer<typeof replySchema>;

/** prompts/dm_screenshot_reader.md の出力 */
export const screenshotSchema = z.object({
  readable: z.boolean(),
  counterpart_name: z.string().nullable(),
  counterpart_username: z.string().nullable(),
  messages: z.array(z.object({ from: z.enum(["them", "me"]), text: z.string() })),
});
export type Screenshot = z.infer<typeof screenshotSchema>;

/** 分類・返信案の入力。①（API 取得）と②（Slack 返信アシスタント）で共通 */
export type DmContext = {
  history: { from: "them" | "me"; text: string }[];
  newMessage: string;
  sender: { name?: string | null; username?: string | null; description?: string | null };
  /** ②でスクショに添えられた代表のメモ */
  note?: string | null;
  /**
   * 初回の返信か（こちらからまだ一度も送っていない相手か）。true なら自己紹介を入れる。
   * ① 自動取得: スレッドにこちらから送った DM が1件もない／② スクショ: 右側（自分）の吹き出しがない／② テキストだけ: false
   */
  firstReply?: boolean;
};
