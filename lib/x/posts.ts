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

const PAGE_SIZE = 100;

/**
 * 代表アカウントの過去の投稿（リポスト・リプライを除く、新しい順）。100件ずつページ送りで最大 maxResults 件。
 * 自分の投稿の読み取りは $0.001／件で、同じ投稿は UTC 日内で1回だけ課金される。
 */
export async function fetchOwnPosts(userId: string, maxResults = 100): Promise<OwnPost[]> {
  const posts: OwnPost[] = [];
  let token: string | undefined;
  while (posts.length < maxResults) {
    const res = await xApi<{ data?: OwnPost[]; meta?: { next_token?: string } }>("users.tweets.own", {
      params: { id: userId },
      query: {
        max_results: Math.min(Math.max(maxResults - posts.length, 5), PAGE_SIZE),
        exclude: "retweets,replies",
        "tweet.fields": "created_at,public_metrics,note_tweet",
        pagination_token: token,
      },
    });
    posts.push(...(res.data ?? []).map((p) => ({ ...p, text: p.note_tweet?.text ?? p.text })));
    token = res.meta?.next_token;
    if (!token || !res.data?.length) break;
  }
  return posts.slice(0, maxResults);
}
