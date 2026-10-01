import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { buildStyleGuideDraft } from "@/lib/style/build";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 文体ガイドの案を作る（管理用）。`POST ?key=$ADMIN_SECRET`
 * 過去投稿 最大100件の取得（約$0.10）と Claude の呼び出しが発生する。結果は未承認で保存される。
 */
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return new NextResponse("Forbidden", { status: 403 });
  const max = Number(new URL(req.url).searchParams.get("max") ?? 100);
  const draft = await buildStyleGuideDraft(Number.isFinite(max) ? max : 100);
  return NextResponse.json(draft);
}
