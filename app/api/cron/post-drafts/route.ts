import { runCron } from "@/lib/cron";
import { createDailyDrafts } from "@/lib/posts/daily";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vercel Cron（毎日 21:00 JST）: 翌日分の投稿案を作って【投稿承認】に出す */
export function GET(req: Request) {
  return runCron(req, "投稿案の作成", () => createDailyDrafts());
}
