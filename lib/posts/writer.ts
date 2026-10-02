import { generateJson, loadPrompt } from "../claude";
import { db } from "../supabase";
import { describeDay, type DayContext } from "./calendar";
import { mechanicalCheck } from "./checks";
import { recentHistory } from "./history";
import { reviewSchema, writerSchema, type PostKind, type ReviewNote } from "./schemas";

const RECENT_POSTS = 30;
const AVOID_ANGLES = 40;
const RECENT_DRAFTS = 20;
const DUPLICATE_POOL = 200;

export type WriteContext = {
  kind: PostKind;
  day: DayContext;
  topic?: string | null;
  /** 作り直しのとき */
  revision?: { previousBody: string; instructions: string[] };
  /** 自分自身（作り直し中の案）を重複判定から外す */
  excludeDraftId?: number;
  /** 同じ日の他の投稿案（締めの言い回しを変えるため） */
  batchBodies?: string[];
};

export type Written = { body: string; reason: string; theme: string; review: ReviewNote };

type Inputs = {
  styleGuide: string;
  insights: string;
  recentPosts: string[];
  avoidAngles: string[];
  recentDrafts: string[];
  pool: { body: string; label: string }[];
};

async function loadInputs(excludeDraftId?: number): Promise<Inputs> {
  const [style, insight, history, drafts] = await Promise.all([
    db().from("style_guide").select("content").eq("approved", true).order("version", { ascending: false }).limit(1),
    db().from("insights").select("summary").order("created_at", { ascending: false }).limit(1),
    recentHistory(DUPLICATE_POOL),
    db()
      .from("post_drafts")
      .select("id, body")
      .not("kind", "is", null)
      .order("id", { ascending: false })
      .limit(RECENT_DRAFTS + 1),
  ]);
  if (drafts.error) throw drafts.error;
  const otherDrafts = (drafts.data ?? []).filter((d) => d.id !== excludeDraftId).slice(0, RECENT_DRAFTS);
  const real = history.filter((h) => !h.fabricated);
  return {
    styleGuide: style.data?.[0]?.content ?? "（未整備）",
    insights: insight.data?.[0]?.summary ?? "（まだなし）",
    recentPosts: real.slice(0, RECENT_POSTS).map((h) => h.body),
    avoidAngles: history.filter((h) => h.fabricated).slice(0, AVOID_ANGLES).map((h) => h.body),
    recentDrafts: otherDrafts.map((d) => d.body),
    pool: [
      ...history.map((h) => ({ body: h.body, label: h.fabricated ? "過去の作り話の投稿" : "過去の投稿" })),
      ...otherDrafts.map((d) => ({ body: d.body, label: "直近の投稿案" })),
    ],
  };
}

const list = (items: string[]) => items.map((b) => `---\n${b}`).join("\n");

function commonParts(ctx: WriteContext, inputs: Inputs): string[] {
  return [
    `<kind>${ctx.kind}</kind>`,
    `<day>${describeDay(ctx.day)}</day>`,
    `<style_guide>\n${inputs.styleGuide}\n</style_guide>`,
    ...(ctx.kind === "personal" ? [`<topic>\n${ctx.topic ?? ""}\n</topic>`] : []),
    `<recent_posts>\n${list(inputs.recentPosts)}\n</recent_posts>`,
    `<avoid_angles>\n${list(inputs.avoidAngles)}\n</avoid_angles>`,
    `<recent_drafts>\n${list(inputs.recentDrafts)}\n</recent_drafts>`,
    `<batch_drafts>\n${list(ctx.batchBodies ?? [])}\n</batch_drafts>`,
  ];
}

/**
 * 投稿案を1つ書き、機械チェック → 審査（reviewer.md）→ 機械チェックを通す。
 * 不可なら1回だけ書き直す。2回とも通らなければ null と理由を返す。
 */
export async function writeAndReview(ctx: WriteContext): Promise<Written | { failed: string }> {
  if (ctx.kind === "personal" && !ctx.topic) return { failed: "personal にはネタが必要です" };
  const inputs = await loadInputs(ctx.excludeDraftId);
  const [writerPrompt, reviewerPrompt] = await Promise.all([loadPrompt("post_writer"), loadPrompt("reviewer")]);
  let lastReason = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const writerUser = [
      ...commonParts(ctx, inputs),
      `<insights>\n${inputs.insights}\n</insights>`,
      ...(ctx.revision
        ? [
            `<previous_body>\n${ctx.revision.previousBody}\n</previous_body>`,
            `<revision_instructions>\n${ctx.revision.instructions.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n</revision_instructions>`,
          ]
        : []),
      ...(attempt > 0 ? [`<retry_reason>\n前の案は次の理由で使えなかった: ${lastReason}\n</retry_reason>`] : []),
    ].join("\n");
    const w = await generateJson({ system: writerPrompt, user: writerUser, schema: writerSchema, maxTokens: 2048 });
    if (!w.ok) {
      lastReason = `作成に失敗（${w.error}）`;
      continue;
    }

    const pre = mechanicalCheck(w.data.body, inputs.pool);
    if (pre.fatal.length) {
      lastReason = pre.fatal.join("、");
      continue;
    }

    const r = await generateJson({
      system: reviewerPrompt,
      user: [...commonParts(ctx, inputs), `<draft>\n${w.data.body}\n</draft>`].join("\n"),
      schema: reviewSchema,
      maxTokens: 2048,
    });
    if (!r.ok) {
      lastReason = `審査に失敗（${r.error}）`;
      continue;
    }
    if (r.data.verdict === "reject") {
      lastReason = r.data.issues.map((i) => `${i.type}: ${i.detail}`).join("、") || "審査で不可";
      continue;
    }

    const body = r.data.verdict === "fix" && r.data.fixed_body ? r.data.fixed_body : w.data.body;
    const post = mechanicalCheck(body, inputs.pool);
    if (post.fatal.length || post.errors.length) {
      lastReason = [...post.fatal, ...post.errors].join("、");
      continue;
    }
    return {
      body,
      reason: w.data.reason,
      theme: w.data.theme,
      review: { verdict: r.data.verdict, issues: r.data.issues, warnings: post.warnings },
    };
  }
  return { failed: lastReason || "審査を通る案を作れませんでした" };
}
