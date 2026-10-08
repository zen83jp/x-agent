import { runCron } from "@/lib/cron";
import { createWeeklyDrafts } from "@/lib/posts/daily";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron（月〜木 17:00〜17:55 JST に5分おき）: 週1回の投稿案の生成。
 * 生成する日（原則木曜、休みなら直前の平日）だけ、翌日から翌週の日曜までのまだ案が無い枠を作る。
 * 1回の実行で終わらなかった分は、次の実行で続きから作る。
 */
export function GET(req: Request) {
  return runCron(req, "投稿案の作成", () => createWeeklyDrafts());
}
