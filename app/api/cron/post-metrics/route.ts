import { runCron } from "@/lib/cron";
import { runMetrics } from "@/lib/posts/metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Vercel Cron（1時間おき）: 投稿から 24h・72h の指標を取得 */
export function GET(req: Request) {
  return runCron(req, "効果測定", () => runMetrics());
}
