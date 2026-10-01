import { notifyAlert } from "./slack/client";
import { getSetting, setSetting } from "./supabase";
import { jstDate } from "./x/budget";

/**
 * 同じ種類のアラートを1日（JST）1回だけ送る。Cron で5分おきに同じエラーが出ても通知が埋もれないように。
 */
export async function notifyAlertOncePerDay(key: string, text: string, now = new Date()): Promise<void> {
  const settingKey = `alert_sent:${key}`;
  const today = jstDate(now);
  try {
    if ((await getSetting<string>(settingKey)) === today) return;
    await setSetting(settingKey, today);
  } catch (e) {
    console.error("notifyAlertOncePerDay: 送信記録の確認に失敗（通知は送る）", e);
  }
  await notifyAlert(text);
}
