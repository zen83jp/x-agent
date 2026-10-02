import { z } from "zod";
import { generateJson, loadPrompt } from "../claude";
import { db } from "../supabase";
import { listDmEvents } from "../x/dm";
import { fetchOwnPosts, type OwnPost } from "../x/posts";

const outputSchema = z.object({ content: z.string() });

export function formatPost(p: OwnPost): string {
  const m = p.public_metrics ?? {};
  const date = p.created_at ? p.created_at.slice(0, 10) : "日付不明";
  const metrics = [
    `いいね${m.like_count ?? 0}`,
    `リポスト${m.retweet_count ?? 0}`,
    `返信${m.reply_count ?? 0}`,
    `引用${m.quote_count ?? 0}`,
    `ブックマーク${m.bookmark_count ?? 0}`,
    ...(m.impression_count !== undefined ? [`表示${m.impression_count}`] : []),
  ].join(" ");
  return `--- ${date} ｜ ${metrics}\n${p.text}`;
}

/** 代表が送った旧形式 DM（文体の参考。暗号化された会話は API で取れないため含まれない） */
async function ownDmSamples(myId: string): Promise<string[]> {
  const { events } = await listDmEvents();
  return events.filter((e) => e.sender_id === myId && e.text).map((e) => e.text!);
}

export type StyleGuideDraft = { id: number; version: number; posts: number; dmSamples: number; content: string };

/**
 * 過去投稿と DM から文体ガイドの案を作り、style_guide に未承認（approved=false）で保存する。
 * 返信案や投稿案が参照するのは承認済みの版だけなので、案を作っても本番の文面には影響しない。
 */
/** 件数と期間はモデルに数えさせず、コードで数えて渡す（数え間違い防止） */
export function summarize(posts: OwnPost[], dmCount: number): string {
  const dates = posts.map((p) => p.created_at?.slice(0, 10)).filter((d): d is string => Boolean(d)).sort();
  const range = dates.length ? `${dates[0]}〜${dates.at(-1)}` : "期間不明";
  return `投稿: ${posts.length}件（${range}）／DM返信: ${dmCount}件`;
}

export async function buildStyleGuideDraft(maxPosts = 100, instructions?: string): Promise<StyleGuideDraft> {
  const { data: auth, error } = await db().from("x_auth").select("x_user_id").eq("id", 1).single();
  if (error) throw error;

  const posts = await fetchOwnPosts(auth.x_user_id, maxPosts);
  if (posts.length === 0) throw new Error("過去の投稿が取得できませんでした");
  const dms = await ownDmSamples(auth.x_user_id);

  const user = [
    `<summary>${summarize(posts, dms.length)}</summary>`,
    `<posts>\n${posts.map(formatPost).join("\n\n")}\n</posts>`,
    `<dm_samples>\n${dms.length ? dms.map((t) => `--- \n${t}`).join("\n\n") : "（なし）"}\n</dm_samples>`,
  ].join("\n\n");
  const system =
    (await loadPrompt("style_guide_builder")) +
    (instructions ? `\n\n## 今回の追加指示（代表から。上の指示より優先する）\n${instructions}` : "") +
    "\n\n## 出力の形式\nMarkdown の文体ガイド全文を JSON の `content` に入れて返す。";

  const res = await generateJson({ system, user, schema: outputSchema, maxTokens: 16000 });
  if (!res.ok) throw new Error(`文体ガイドの生成に失敗しました: ${res.error}`);

  const { data: latest } = await db().from("style_guide").select("version").order("version", { ascending: false }).limit(1);
  const version = (latest?.[0]?.version ?? 0) + 1;
  const { data: row, error: insErr } = await db()
    .from("style_guide")
    .insert({ version, content: res.data.content, approved: false })
    .select("id")
    .single();
  if (insErr) throw insErr;
  return { id: row.id, version, posts: posts.length, dmSamples: dms.length, content: res.data.content };
}
