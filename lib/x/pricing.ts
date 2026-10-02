/**
 * X API の操作定義と課金ルール。
 * ここに定義のない操作は xApi() から呼べない（単価未確認の呼び出しを防ぐため）。
 *
 * 単価は 2026年9月末時点の公表値（https://docs.x.com/x-api/getting-started/pricing）。
 *   - 他者の投稿の読み取り: $0.005／件
 *   - 自分の投稿・フォロワー等の読み取り: $0.001／件
 *   - ユーザー情報の読み取り: $0.010／件
 *   - DM イベントの読み取り: $0.010／件
 *   - 投稿作成: $0.015／件（URL 入りは $0.20。ただし URL 入りの投稿は assertNoUrlInPost で止めるので発生しない）
 *   - DM 送信: $0.015／件
 * 読み取りは「同じリソースは UTC 日内で1回だけ課金」なので、返ってきたリソースを列挙して
 * billing.ts で重複を除いた分だけ計上する。作成系はリクエストごとに課金。
 */
export type ResourceType = "dm_event" | "user" | "post" | "own_post";

export const RESOURCE_COST_USD: Record<ResourceType, number> = {
  dm_event: 0.01,
  user: 0.01,
  post: 0.005,
  own_post: 0.001,
};

export type BilledResource = { type: ResourceType; id: string };

type Billing =
  | { kind: "request"; costUsd: number }
  | {
      kind: "resources";
      /** 事前の予算チェック用。1件あたりの最大額（展開されるユーザー分も含める） */
      estimateUnitUsd: number;
      extract: (json: unknown) => BilledResource[];
    };

export type XOpDef = { method: "GET" | "POST" | "DELETE"; path: string; billing: Billing };

type Json = { data?: unknown; includes?: { users?: unknown } } | null;

function ids(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map((v) => (v as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string");
}

const asResources = (type: ResourceType, list: string[]): BilledResource[] => list.map((id) => ({ type, id }));

export const X_OPS = {
  "users.me": {
    method: "GET",
    path: "/2/users/me",
    billing: { kind: "resources", estimateUnitUsd: 0.01, extract: (j) => asResources("user", ids((j as Json)?.data)) },
  },
  "dm_events.list": {
    method: "GET",
    path: "/2/dm_events",
    billing: {
      kind: "resources",
      estimateUnitUsd: 0.02,
      extract: (j) => [
        ...asResources("dm_event", ids((j as Json)?.data)),
        ...asResources("user", ids((j as Json)?.includes?.users)),
      ],
    },
  },
  "dm.send": {
    method: "POST",
    path: "/2/dm_conversations/:dm_conversation_id/messages",
    billing: { kind: "request", costUsd: 0.015 },
  },
  "tweets.create": { method: "POST", path: "/2/tweets", billing: { kind: "request", costUsd: 0.015 } },
  // 代表アカウント自身のタイムライン（自分の投稿の読み取り＝Owned Reads）
  "users.tweets.own": {
    method: "GET",
    path: "/2/users/:id/tweets",
    billing: { kind: "resources", estimateUnitUsd: 0.001, extract: (j) => asResources("own_post", ids((j as Json)?.data)) },
  },
  // 同じエンドポイントでも、誰の投稿を読むかで単価が違うため操作を分けている
  "tweets.lookup.own": {
    method: "GET",
    path: "/2/tweets",
    billing: { kind: "resources", estimateUnitUsd: 0.001, extract: (j) => asResources("own_post", ids((j as Json)?.data)) },
  },
  "tweets.lookup.others": {
    method: "GET",
    path: "/2/tweets",
    billing: { kind: "resources", estimateUnitUsd: 0.005, extract: (j) => asResources("post", ids((j as Json)?.data)) },
  },
} as const satisfies Record<string, XOpDef>;

export type XOp = keyof typeof X_OPS;

/** 事前の予算チェックで使う最悪値（max_results 件、または ids の件数すべてが未課金だった場合） */
export function estimateCostUsd(def: XOpDef, query?: Record<string, string | number | undefined>): number {
  if (def.billing.kind === "request") return def.billing.costUsd;
  const ids = typeof query?.ids === "string" ? query.ids.split(",").filter(Boolean).length : 0;
  const n = Number(query?.max_results ?? (ids || 1));
  return def.billing.estimateUnitUsd * (Number.isFinite(n) && n > 0 ? n : 1);
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
