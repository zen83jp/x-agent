import { env } from "../env";
import { db, getSetting, setSetting } from "../supabase";
import { notifyAlert } from "../slack/client";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly estimateUsd: number,
    readonly budgetUsd: number,
  ) {
    super(`X API の日次予算超過: 使用 $${spentUsd.toFixed(4)} + 今回 $${estimateUsd.toFixed(4)} > 上限 $${budgetUsd}`);
    this.name = "BudgetExceededError";
  }
}

/** JST の当日 0:00 を UTC の Date で返す */
export function jstDayStart(now: Date): Date {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  jst.setUTCHours(0, 0, 0, 0);
  return new Date(jst.getTime() - JST_OFFSET_MS);
}

/** JST の日付文字列（YYYY-MM-DD） */
export function jstDate(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function isOverBudget(spentUsd: number, estimateUsd: number, budgetUsd: number): boolean {
  return spentUsd + estimateUsd > budgetUsd;
}

export async function spentTodayUsd(now = new Date()): Promise<number> {
  const { data, error } = await db()
    .from("x_api_usage")
    .select("est_cost_usd")
    .gte("called_at", jstDayStart(now).toISOString());
  if (error) throw error;
  return (data ?? []).reduce((sum, r) => sum + Number(r.est_cost_usd), 0);
}

/**
 * 今回の呼び出しで日次予算を超えるなら BudgetExceededError を投げる。
 * 超過時の Slack 通知は1日1回だけ。
 */
export async function assertWithinBudget(estimateUsd: number, now = new Date()): Promise<void> {
  const budget = env().X_DAILY_BUDGET_USD;
  const spent = await spentTodayUsd(now);
  if (!isOverBudget(spent, estimateUsd, budget)) return;

  const err = new BudgetExceededError(spent, estimateUsd, budget);
  const today = jstDate(now);
  if ((await getSetting<string>("budget_alert_sent_on")) !== today) {
    await setSetting("budget_alert_sent_on", today);
    await notifyAlert(`${err.message}\n本日（JST）の X API 呼び出しを停止しました。`);
  }
  throw err;
}

/**
 * x_api_usage への記録。記録の失敗で本処理（送信済みの DM など）を失敗扱いにすると
 * 再実行で二重送信になりうるため、例外は投げずにアラートだけ出す。
 */
export async function recordUsage(row: {
  endpoint: string;
  units: number;
  estCostUsd: number;
  status: number;
}): Promise<void> {
  const { error } = await db().from("x_api_usage").insert({
    endpoint: row.endpoint,
    units: row.units,
    est_cost_usd: row.estCostUsd,
    status: row.status,
  });
  if (error) {
    console.error("recordUsage failed", error, row);
    await notifyAlert(`x_api_usage への記録に失敗しました（${row.endpoint} / ${row.status}）: ${error.message}`);
  }
}
