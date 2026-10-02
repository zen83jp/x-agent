import { runCron } from "@/lib/cron";
import { createScheduledDrafts } from "@/lib/posts/daily";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron（平日 9:00 JST）: 翌日から次の平日までの各日の投稿案を作って【投稿承認】に出す。
 * 祝日は中で判定して何もしない。
 */
export function GET(req: Request) {
  return runCron(req, "投稿案の作成", () => createScheduledDrafts());
}
