import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { pollDms } from "@/lib/dm/poll";
import { notifyAlert } from "@/lib/slack/client";
import { BudgetExceededError } from "@/lib/x/budget";
import { XAuthError } from "@/lib/x/oauth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vercel Cron（5分おき）: 旧形式 DM のポーリング */
export async function GET(req: Request) {
  if (!isCronRequest(req)) return new NextResponse("Forbidden", { status: 403 });
  try {
    return NextResponse.json(await pollDms());
  } catch (e) {
    // 予算超過・認可切れはそれぞれの箇所で通知済み
    if (e instanceof BudgetExceededError || e instanceof XAuthError) {
      return NextResponse.json({ status: "stopped", reason: e.name });
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("dm-poll failed", e);
    await notifyAlert(`DM ポーリングに失敗しました: ${msg}`);
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
