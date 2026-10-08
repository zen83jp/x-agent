import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "./env";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : null;
}

/**
 * Vercel Cron からの呼び出しか。Vercel は CRON_SECRET が登録されていると `Authorization: Bearer $CRON_SECRET` を付けて呼ぶ。
 * 管理用の合言葉（ADMIN_SECRET）では通さない
 */
export function isCronRequest(req: Request): boolean {
  const token = bearerToken(req);
  return token !== null && safeEqual(token, env().CRON_SECRET);
}

/**
 * 管理用 API の保護（`Authorization: Bearer $ADMIN_SECRET`）。
 * 合言葉は URL に載せない（アクセスログに残るため）。`?key=` は廃止した
 */
export function isAdminRequest(req: Request): boolean {
  const token = bearerToken(req);
  return token !== null && safeEqual(token, env().ADMIN_SECRET);
}

/**
 * ブラウザで開く管理用ページ（X の認可）の保護。Basic 認証で、パスワードに ADMIN_SECRET を入れる（ユーザー名は何でもよい）。
 * ブラウザが Authorization ヘッダーで送るので、URL には残らない
 */
export function isAdminBasic(req: Request): boolean {
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Basic ")) return false;
  const decoded = Buffer.from(h.slice("Basic ".length), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  return sep >= 0 && safeEqual(decoded.slice(sep + 1), env().ADMIN_SECRET);
}

/** 管理用 API の 401。`?key=` で呼ばれたときは、廃止したことを伝える */
export function adminUnauthorized(req: Request): Response {
  const usedKeyQuery = new URL(req.url).searchParams.has("key");
  return NextResponse.json(
    {
      error: usedKeyQuery
        ? "?key= での認証は廃止しました。合言葉は Authorization: Bearer <ADMIN_SECRET> ヘッダーで渡してください"
        : "認証が必要です。Authorization: Bearer <ADMIN_SECRET> ヘッダーで渡してください",
    },
    { status: 401 },
  );
}

/** ブラウザにパスワード（ADMIN_SECRET）を聞かせる 401 */
export function basicChallenge(): Response {
  return new NextResponse("認証が必要です。パスワードに ADMIN_SECRET を入力してください（ユーザー名は空欄で構いません）", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="x-agent admin", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" },
  });
}
