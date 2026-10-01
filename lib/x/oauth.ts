import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { env } from "../env";
import { db } from "../supabase";
import { notifyAlert } from "../slack/client";
import { recordUsage } from "./budget";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "dm.read", "dm.write", "offline.access"];

/** 期限のこれだけ前になったら refresh する */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class XAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XAuthError";
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

export function buildAuthorizeUrl(state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env().X_CLIENT_ID);
  url.searchParams.set("redirect_uri", env().X_REDIRECT_URI);
  url.searchParams.set("scope", X_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenResponse>;

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const { X_CLIENT_ID, X_CLIENT_SECRET } = env();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({ ...params, client_id: X_CLIENT_ID }),
  });
  // トークン発行は課金対象外だが、CLAUDE.md の方針どおり全呼び出しを記録する
  await recordUsage({ endpoint: "POST /2/oauth2/token", units: 1, estCostUsd: 0, status: res.status });

  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new XAuthError(`token endpoint ${res.status}: ${JSON.stringify(json)}`);
  const parsed = tokenResponse.safeParse(json);
  if (!parsed.success) throw new XAuthError(`token response の形式が想定外です: ${parsed.error.message}`);
  return parsed.data;
}

export function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  return postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: env().X_REDIRECT_URI,
    code_verifier: verifier,
  });
}

type AuthRow = { x_user_id: string; access_token: string; refresh_token: string; expires_at: string };

async function readAuth(): Promise<AuthRow | null> {
  const { data, error } = await db()
    .from("x_auth")
    .select("x_user_id, access_token, refresh_token, expires_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveTokens(xUserId: string, t: TokenResponse): Promise<void> {
  const { error } = await db()
    .from("x_auth")
    .upsert({
      id: 1,
      x_user_id: xUserId,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    });
  if (error) throw error;
}

/**
 * 有効なアクセストークンを返す。期限が近い（または force）なら refresh して保存する。
 *
 * X の refresh token は使うたびに新しいものに置き換わる。並行実行で古い refresh token を
 * 使ってしまった場合は失敗するので、そのときは DB を読み直し、別プロセスが更新済みならそれを使う。
 */
export async function getValidAccessToken(opts: { force?: boolean } = {}): Promise<string> {
  const row = await readAuth();
  if (!row) throw new XAuthError("X が未認可です。/api/x/authorize から認可してください");

  const expiresAt = new Date(row.expires_at).getTime();
  if (!opts.force && expiresAt - Date.now() > REFRESH_MARGIN_MS) return row.access_token;

  let tokens: TokenResponse;
  try {
    tokens = await postToken({ grant_type: "refresh_token", refresh_token: row.refresh_token });
  } catch (e) {
    const latest = await readAuth();
    if (latest && latest.refresh_token !== row.refresh_token) return latest.access_token;
    await notifyAlert(
      `X のトークン更新に失敗しました。代表アカウントで再認可してください（/api/x/authorize）。\n${String(e)}`,
    );
    throw e;
  }
  await saveTokens(row.x_user_id, tokens);
  return tokens.access_token;
}
