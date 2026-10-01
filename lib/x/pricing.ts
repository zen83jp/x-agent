/**
 * X API の操作定義と推定単価（USD）。
 * ここに定義のない操作は xApi() から呼べない（単価未確認の呼び出しを防ぐため）。
 *
 * 単価は 2026年9月末時点の公表値。X 設定時に開発者コンソールの料金表で最終確認すること。
 *   - 他者の投稿の読み取り: $0.005／件
 *   - 自分の投稿・フォロワー等の読み取り: $0.001／件
 *   - ユーザー情報の読み取り: $0.010／件
 *   - DM イベントの読み取り: $0.010／件
 *   - 投稿作成: $0.015／件（URL 入りは $0.20。ただし URL 入りの投稿は assertNoUrlInPost で止めるので発生しない）
 *   - DM 送信: $0.015／件
 * perResource: true の操作は「返ってきたリソース数 × 単価」で課金される想定。
 * 事前の予算チェックでは max_results（なければ1）件分を見積もる。
 */
export const X_OPS = {
  "users.me": { method: "GET", path: "/2/users/me", unitCostUsd: 0.01, perResource: true },
  "dm_events.list": { method: "GET", path: "/2/dm_events", unitCostUsd: 0.01, perResource: true },
  "dm.send": {
    method: "POST",
    path: "/2/dm_conversations/:dm_conversation_id/messages",
    unitCostUsd: 0.015,
    perResource: false,
  },
  "tweets.create": { method: "POST", path: "/2/tweets", unitCostUsd: 0.015, perResource: false },
  // 同じエンドポイントでも、誰の投稿を読むかで単価が違うため操作を分けている
  "tweets.lookup.own": { method: "GET", path: "/2/tweets", unitCostUsd: 0.001, perResource: true },
  "tweets.lookup.others": { method: "GET", path: "/2/tweets", unitCostUsd: 0.005, perResource: true },
} as const satisfies Record<string, XOpDef>;

export type XOpDef = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  unitCostUsd: number;
  perResource: boolean;
};

export type XOp = keyof typeof X_OPS;

/** 事前見積もりの件数 */
export function estimateUnits(def: XOpDef, query?: Record<string, string | number | undefined>): number {
  if (!def.perResource) return 1;
  const n = Number(query?.max_results ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** レスポンスから実際の課金件数を数える */
export function actualUnits(def: XOpDef, json: unknown): number {
  if (!def.perResource) return 1;
  const data = (json as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return data.length;
  return data ? 1 : 0;
}

const URL_PATTERN =
  /https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|jp|co\.jp|io|ai|online|me|app|dev|info|biz|xyz|link|ly)\b/i;

/**
 * 本文に URL（X が自動リンク化しそうなドメイン表記を含む）があるか。
 * URL 入りの投稿は高額なので作らない（CLAUDE.md の絶対ルール）。
 */
export function containsUrl(text: string): boolean {
  return URL_PATTERN.test(text);
}
