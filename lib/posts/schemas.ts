import { z } from "zod";

export const POST_KINDS = ["greeting", "business", "personal"] as const;
export type PostKind = (typeof POST_KINDS)[number];

export const writerSchema = z.object({
  body: z.string(),
  reason: z.string(),
  theme: z.string(),
});
export type WriterOutput = z.infer<typeof writerSchema>;

export const ISSUE_TYPES = ["legal", "url", "style", "fact", "duplicate", "calendar", "length", "other"] as const;

export const reviewSchema = z.object({
  verdict: z.enum(["pass", "fix", "reject"]),
  issues: z.array(z.object({ type: z.enum(ISSUE_TYPES), detail: z.string() })),
  fixed_body: z.string().nullable(),
});
export type ReviewOutput = z.infer<typeof reviewSchema>;

export type Issue = ReviewOutput["issues"][number];

/** post_drafts.review_note に保存する審査結果 */
export type ReviewNote = {
  verdict: ReviewOutput["verdict"];
  issues: Issue[];
  /** 機械チェックで残った注意（重複候補など。止めはしない） */
  warnings: string[];
};
