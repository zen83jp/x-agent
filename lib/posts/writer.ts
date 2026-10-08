import { generateJson, loadPrompt } from "../claude";
import { db } from "../supabase";
import { addDays, describeDay, weekRange, type DayContext } from "./calendar";
import { mechanicalCheck, weekOverlapWarnings, type WeekDraft } from "./checks";
import { recentHistory } from "./history";
import { reviewSchema, writerSchema, type PostKind, type ReviewNote } from "./schemas";

const RECENT_POSTS = 30;
const AVOID_ANGLES = 40;
const RECENT_DRAFTS = 20;
const DUPLICATE_POOL = 200;
/**
 * 書いて審査を通すまでの最大回数。週の生成では同じ週の案と切り口が重なって不可になることがあるので、
 * 前の案が使えなかった理由を渡して最大3回まで書き直す（不可にならなければ1回で終わる）
 */
const MAX_ATTEMPTS = 3;

export type WriteContext = {
  kind: PostKind;
  day: DayContext;
  topic?: string | null;
  /** 作り直しのとき */
  revision?: { previousBody: string; instructions: string[] };
  /** 自分自身（作り直し中の案）を重複判定から外す */
  excludeDraftId?: number;
  /**
   * 同じ週（前日を含む）の他の投稿案。締め・特徴的な言い回し・テーマを重ねないため。
   * 省略すると DB から読む（試験生成では、DB に書かずに作った案をここで渡す）
   */
  weekDrafts?: WeekDraft[];
  /** 承認されずに期限切れになった案（参考。使い回さない） */
  material?: { body: string; reason: string | null } | null;
};

export type Written = { body: string; reason: string; theme: string; review: ReviewNote };

type Inputs = {
  weekDrafts: WeekDraft[];
  styleGuide: string;
  insights: string;
  recentPosts: string[];
  avoidAngles: string[];
  recentDrafts: string[];
  pool: { body: string; label: string }[];
};

/** 前日の日付（YYYY-MM-DD） */
export function previousDate(date: string): string {
  return addDays(date, -1);
}

/** 同じ週（月〜日）と前日の、生きている投稿案（承認待ち・承認済み・投稿中・投稿済み） */
export async function loadWeekDrafts(date: string, excludeDraftId?: number): Promise<WeekDraft[]> {
  const { to } = weekRange(date);
  const from = [weekRange(date).from, previousDate(date)].sort()[0]!;
  const { data, error } = await db()
    .from("post_drafts")
    .select("id, kind, body, theme, target_date")
    .gte("target_date", from)
    .lte("target_date", to)
    .in("review_status", ["awaiting_approval", "approved", "posting", "posted"]);
  if (error) throw error;
  return (data ?? [])
    .filter((d) => d.id !== excludeDraftId && d.kind)
    .map((d) => ({ kind: d.kind, body: d.body, theme: d.theme ?? "", date: d.target_date }));
}

async function loadInputs(ctx: WriteContext): Promise<Inputs> {
  const excludeDraftId = ctx.excludeDraftId;
  const [style, insight, history, drafts, week] = await Promise.all([
    db().from("style_guide").select("content").eq("approved", true).order("version", { ascending: false }).limit(1),
    db().from("insights").select("summary").order("created_at", { ascending: false }).limit(1),
    recentHistory(DUPLICATE_POOL),
    db()
      .from("post_drafts")
      .select("id, body")
      .not("kind", "is", null)
      // 期限切れの案は投稿されていないので、重複の判定には使わない（材料として別に渡す）
      .neq("review_status", "expired")
      .order("id", { ascending: false })
      .limit(RECENT_DRAFTS + 1),
    ctx.weekDrafts ? Promise.resolve(ctx.weekDrafts) : loadWeekDrafts(ctx.day.date, excludeDraftId),
  ]);
  if (drafts.error) throw drafts.error;
  const otherDrafts = (drafts.data ?? []).filter((d) => d.id !== excludeDraftId).slice(0, RECENT_DRAFTS);
  const real = history.filter((h) => !h.fabricated);
  return {
    weekDrafts: week,
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
    `<week_drafts>\n${inputs.weekDrafts
      .map((d) => `--- [${d.date.slice(5).replace("-", "/")} ${d.kind}] テーマ: ${d.theme}\n${d.body}`)
      .join("\n")}\n</week_drafts>`,
  ];
}

/**
 * 投稿案を1つ書き、機械チェック → 審査（reviewer.md）→ 機械チェックを通す。
 * 不可なら理由を渡して書き直す（最大 MAX_ATTEMPTS 回）。すべて通らなければ失敗とその理由を返す。
 */
export async function writeAndReview(ctx: WriteContext): Promise<Written | { failed: string }> {
  if (ctx.kind === "personal" && !ctx.topic) return { failed: "personal にはネタが必要です" };
  const inputs = await loadInputs(ctx);
  const [writerPrompt, reviewerPrompt] = await Promise.all([loadPrompt("post_writer"), loadPrompt("reviewer")]);
  let lastReason = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const writerUser = [
      ...commonParts(ctx, inputs),
      `<insights>\n${inputs.insights}\n</insights>`,
      ...(ctx.material
        ? [`<expired_material>\n${ctx.material.body}${ctx.material.reason ? `\n（狙い: ${ctx.material.reason}）` : ""}\n</expired_material>`]
        : []),
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
    const overlap = weekOverlapWarnings({ kind: ctx.kind, body, theme: w.data.theme }, inputs.weekDrafts);
    return {
      body,
      reason: w.data.reason,
      theme: w.data.theme,
      review: { verdict: r.data.verdict, issues: r.data.issues, warnings: [...post.warnings, ...overlap] },
    };
  }
  return { failed: lastReason || "審査を通る案を作れませんでした" };
}
