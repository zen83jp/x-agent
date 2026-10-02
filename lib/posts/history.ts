import { db } from "../supabase";
import { fetchOwnPosts } from "../x/posts";

/**
 * 別ツールの AI が作った「フルリモートの日常ネタ」（実話ではない）を見つけるためのキーワード。
 * 自動判定は候補（fabricated_suggested）にとどめ、代表の確認で fabricated を確定する。
 */
const FABRICATED_PATTERNS: RegExp[] = [
  /独り言/,
  /音声が飛/,
  /宅配便|インターホン/,
  /電気代/,
  /Wi-?Fi|ワイファイ/i,
  /カフェ(で|に)/,
  /ジャケット|部屋着|パジャマ/,
  /夢を見ました/,
  /生活音/,
  /フルリモート(歴|[0-9０-９]+年)/,
  /歩数/,
  /通勤って/,
  /今日のランチ/,
  /サウナ/,
  /Zoom背景|移動時間ゼロ/,
  /お菓子/,
  /コーヒー豆/,
  /ミュート/,
];

export function suggestFabricated(text: string): string | null {
  const hit = FABRICATED_PATTERNS.find((re) => re.test(text));
  return hit ? hit.source : null;
}

export type HistoryPost = { x_post_id: string; body: string; posted_at: string | null; fabricated: boolean };

/**
 * 代表アカウントの過去投稿を保管庫に取り込む（最大 max 件。$0.001／件、同じ投稿は UTC 日内で1回だけ課金）。
 * 確定済みの fabricated は上書きしない。
 */
export async function importHistory(max: number): Promise<{ imported: number; suggested: { id: string; posted_at: string | null; body: string; keyword: string }[] }> {
  const { data: auth, error } = await db().from("x_auth").select("x_user_id").eq("id", 1).single();
  if (error) throw error;
  const posts = await fetchOwnPosts(auth.x_user_id, max);
  const rows = posts.map((p) => ({
    x_post_id: p.id,
    body: p.text,
    posted_at: p.created_at ?? null,
    metrics: p.public_metrics ?? null,
    fabricated_suggested: suggestFabricated(p.text) !== null,
  }));
  if (rows.length) {
    const { error: upErr } = await db().from("x_post_history").upsert(rows, { onConflict: "x_post_id" });
    if (upErr) throw upErr;
  }
  return {
    imported: rows.length,
    suggested: posts
      .map((p) => ({ id: p.id, posted_at: p.created_at ?? null, body: p.text, keyword: suggestFabricated(p.text) }))
      .filter((p): p is typeof p & { keyword: string } => p.keyword !== null),
  };
}

/** パイプラインで投稿したものを保管庫に追加する */
export async function addPipelinePost(xPostId: string, body: string, postedAt: string): Promise<void> {
  const { error } = await db()
    .from("x_post_history")
    .upsert({ x_post_id: xPostId, body, posted_at: postedAt, source: "pipeline", fabricated: false }, { onConflict: "x_post_id" });
  if (error) throw error;
}

/**
 * 直近の投稿。fabricated が未確定の間は、自動判定の候補を作り話として扱う（安全側）。
 */
export async function recentHistory(limit: number): Promise<HistoryPost[]> {
  const { data, error } = await db()
    .from("x_post_history")
    .select("x_post_id, body, posted_at, fabricated, fabricated_suggested")
    .order("posted_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    x_post_id: r.x_post_id,
    body: r.body,
    posted_at: r.posted_at,
    fabricated: r.fabricated ?? r.fabricated_suggested,
  }));
}
