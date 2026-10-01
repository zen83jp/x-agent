import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { buildAuthorizeUrl, generatePkce, generateState } from "@/lib/x/oauth";

export const dynamic = "force-dynamic";

const COOKIE_MAX_AGE_SEC = 10 * 60;

/** 代表アカウントでの X 認可を開始する。`?key=$ADMIN_SECRET` が必要 */
export function GET(req: Request) {
  if (!isAdminRequest(req)) return new NextResponse("Forbidden", { status: 403 });

  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const res = NextResponse.redirect(buildAuthorizeUrl(state, challenge));
  const cookie = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/x/callback",
    maxAge: COOKIE_MAX_AGE_SEC,
  };
  res.cookies.set("x_oauth_state", state, cookie);
  res.cookies.set("x_oauth_verifier", verifier, cookie);
  return res;
}
