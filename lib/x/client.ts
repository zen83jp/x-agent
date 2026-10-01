import { assertWithinBudget, recordUsage } from "./budget";
import { getValidAccessToken } from "./oauth";
import { X_OPS, actualUnits, containsUrl, estimateUnits, type XOp } from "./pricing";

const API_BASE = "https://api.x.com";

export class XApiError extends Error {
  constructor(
    readonly op: XOp,
    readonly status: number,
    readonly body: unknown,
    /** 429 のとき、レート制限が解除される時刻 */
    readonly rateLimitReset?: Date,
  ) {
    super(`X API ${op} failed: ${status} ${JSON.stringify(body)}`);
    this.name = "XApiError";
  }
}

export class UrlInPostError extends Error {
  constructor() {
    super("本文に URL が含まれているため投稿しません（Slack で要確認）");
    this.name = "UrlInPostError";
  }
}

/**
 * URL 入りの「投稿」だけを止める。DM の返信（FAQ の応募ページ案内など）は URL を含んでよい。
 */
export function assertNoUrlInPost(op: XOp, body: unknown): void {
  if (op !== "tweets.create") return;
  const text = (body as { text?: unknown } | undefined)?.text;
  if (typeof text === "string" && containsUrl(text)) throw new UrlInPostError();
}

type Query = Record<string, string | number | undefined>;

export type XApiOptions = {
  /** パスの `:name` を置き換える値 */
  params?: Record<string, string>;
  query?: Query;
  body?: unknown;
  /** 認可直後など、DB に保存する前のトークンで呼ぶとき */
  accessToken?: string;
};

function buildUrl(path: string, params: Record<string, string> = {}, query: Query = {}): string {
  const filled = path.replace(/:([a-z_]+)/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`path param "${name}" がありません`);
    return encodeURIComponent(v);
  });
  const url = new URL(API_BASE + filled);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

/**
 * X API を呼ぶ唯一の入口。予算チェック → 呼び出し → x_api_usage への記録を必ず通す。
 */
export async function xApi<T>(op: XOp, opts: XApiOptions = {}): Promise<T> {
  const def = X_OPS[op];
  assertNoUrlInPost(op, opts.body);

  await assertWithinBudget(def.unitCostUsd * estimateUnits(def, opts.query));

  const url = buildUrl(def.path, opts.params, opts.query);
  const endpoint = `${def.method} ${def.path}`;
  const call = (token: string) =>
    fetch(url, {
      method: def.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await call(opts.accessToken ?? (await getValidAccessToken()));
  if (res.status === 401 && !opts.accessToken) {
    await recordUsage({ endpoint, units: 0, estCostUsd: 0, status: res.status });
    res = await call(await getValidAccessToken({ force: true }));
  }

  const json: unknown = await res.json().catch(() => null);
  const units = res.ok ? actualUnits(def, json) : 0;
  await recordUsage({ endpoint, units, estCostUsd: units * def.unitCostUsd, status: res.status });

  if (!res.ok) {
    const reset = res.headers.get("x-rate-limit-reset");
    throw new XApiError(op, res.status, json, reset ? new Date(Number(reset) * 1000) : undefined);
  }
  return json as T;
}
