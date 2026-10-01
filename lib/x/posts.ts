import { xApi } from "./client";

export type PublicMetrics = {
  like_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  bookmark_count?: number;
  impression_count?: number;
};

export type OwnPost = {
  id: string;
  text: string;
  created_at?: string;
  public_metrics?: PublicMetrics;
  /** 280字を超える長文投稿の全文 */
  note_tweet?: { text?: string };
};

/**
 * 代表アカウントの過去の投稿（リポスト・リプライを除く、新しい順）。
 * 自分の投稿の読み取りは $0.001／件で、同じ投稿は UTC 日内で1回だけ課金される。
 */
export async function fetchOwnPosts(userId: string, maxResults = 100): Promise<OwnPost[]> {
  const res = await xApi<{ data?: OwnPost[] }>("users.tweets.own", {
    params: { id: userId },
    query: {
      max_results: Math.min(Math.max(maxResults, 5), 100),
      exclude: "retweets,replies",
      "tweet.fields": "created_at,public_metrics,note_tweet",
    },
  });
  return (res.data ?? []).map((p) => ({ ...p, text: p.note_tweet?.text ?? p.text }));
}
