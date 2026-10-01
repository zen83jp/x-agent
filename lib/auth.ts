import { timingSafeEqual } from "node:crypto";
import { env } from "./env";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Vercel Cron からの呼び出しか（`Authorization: Bearer $CRON_SECRET`） */
export function isCronRequest(req: Request): boolean {
  return safeEqual(req.headers.get("authorization") ?? "", `Bearer ${env().CRON_SECRET}`);
}

/** 管理用エンドポイントの保護（`?key=$ADMIN_SECRET`） */
export function isAdminRequest(req: Request): boolean {
  return safeEqual(new URL(req.url).searchParams.get("key") ?? "", env().ADMIN_SECRET);
}
