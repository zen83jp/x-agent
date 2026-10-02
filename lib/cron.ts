import { NextResponse } from "next/server";
import { isCronRequest } from "./auth";
import { notifyAlert } from "./slack/client";
import { BudgetExceededError } from "./x/budget";
import { XAuthError } from "./x/oauth";

/** Cron ルートの共通処理: 認証、予算超過・認可切れの扱い（通知済み）、それ以外のエラーのアラート */
export async function runCron(req: Request, name: string, job: () => Promise<unknown>): Promise<Response> {
  if (!isCronRequest(req)) return new NextResponse("Forbidden", { status: 403 });
  try {
    return NextResponse.json(await job());
  } catch (e) {
    if (e instanceof BudgetExceededError || e instanceof XAuthError) {
      return NextResponse.json({ status: "stopped", reason: e.name });
    }
    console.error(`${name} failed`, e);
    await notifyAlert(`${name} に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
