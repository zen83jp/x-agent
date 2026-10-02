import { runCron } from "@/lib/cron";
import { runPublish } from "@/lib/posts/publish";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Vercel Cron（5分おき）: 期限切れの処理と、承認済みの案の予約投稿 */
export function GET(req: Request) {
  return runCron(req, "予約投稿", () => runPublish());
}
