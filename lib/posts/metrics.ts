import { db } from "../supabase";
import { xApi } from "../x/client";

const HOUR = 60 * 60 * 1000;
export const CHECKPOINTS = [
  { name: "24h", afterMs: 24 * HOUR },
  { name: "72h", afterMs: 72 * HOUR },
] as const;
/** これより古い投稿は測らない（取りこぼしを延々と追わない。非公開指標は投稿から30日まで） */
const LOOKBACK_MS = 7 * 24 * HOUR;
const BATCH = 100;

type Metrics = {
  public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number; bookmark_count?: number; impression_count?: number };
  non_public_metrics?: { impression_count?: number; user_profile_clicks?: number };
};

/** 測るべき時点（投稿からの経過時間が過ぎていて、まだ記録していないもの） */
export function dueCheckpoints(postedAt: Date, done: string[], now: Date): string[] {
  return CHECKPOINTS.filter((c) => now.getTime() - postedAt.getTime() >= c.afterMs && !done.includes(c.name)).map((c) => c.name);
}

/** 1時間おき: 投稿から 24h・72h たったものの指標を取って post_metrics に保存する（Phase 4 の分析用） */
export async function runMetrics(now = new Date()): Promise<{ captured: number }> {
  const { data: posts, error } = await db()
    .from("posts")
    .select("x_post_id, posted_at, post_metrics(checkpoint)")
    .gte("posted_at", new Date(now.getTime() - LOOKBACK_MS).toISOString())
    .lte("posted_at", new Date(now.getTime() - CHECKPOINTS[0].afterMs).toISOString());
  if (error) throw error;

  const todo = (posts ?? [])
    .map((p) => {
      const done = ((p.post_metrics ?? []) as { checkpoint: string | null }[]).map((m) => m.checkpoint ?? "");
      const due = dueCheckpoints(new Date(p.posted_at), done, now);
      // 同じ時点に2つ溜まっていたら新しい方だけ（72h を過ぎてから初めて測る場合）
      return { id: p.x_post_id as string, checkpoint: due.at(-1) };
    })
    .filter((t): t is { id: string; checkpoint: string } => Boolean(t.checkpoint));

  let captured = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    // 自分の投稿の読み取り（$0.001／件）。非公開指標（表示数・プロフィールのクリック）は本人のトークンでだけ取れる
    const res = await xApi<{ data?: ({ id: string } & Metrics)[] }>("tweets.lookup.own", {
      query: { ids: batch.map((b) => b.id).join(","), "tweet.fields": "public_metrics,non_public_metrics" },
    });
    const byId = new Map((res.data ?? []).map((d) => [d.id, d]));
    const rows = batch
      .filter((b) => byId.has(b.id))
      .map((b) => {
        const m = byId.get(b.id)!;
        return {
          x_post_id: b.id,
          checkpoint: b.checkpoint,
          impressions: m.non_public_metrics?.impression_count ?? m.public_metrics?.impression_count ?? null,
          likes: m.public_metrics?.like_count ?? null,
          reposts: m.public_metrics?.retweet_count ?? null,
          replies: m.public_metrics?.reply_count ?? null,
          bookmarks: m.public_metrics?.bookmark_count ?? null,
          profile_clicks: m.non_public_metrics?.user_profile_clicks ?? null,
        };
      });
    if (rows.length) {
      const { error: insErr } = await db()
        .from("post_metrics")
        .upsert(rows, { onConflict: "x_post_id,checkpoint", ignoreDuplicates: true });
      if (insErr) throw insErr;
      captured += rows.length;
    }
  }
  return { captured };
}
