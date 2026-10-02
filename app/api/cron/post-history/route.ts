import { runCron } from "@/lib/cron";
import { importHistory } from "@/lib/posts/history";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Vercel Cron（毎週月曜 9:00 JST）: 直近100件の投稿を保管庫に取り込む（X アプリから手で投稿した分も含める。約$0.10） */
export function GET(req: Request) {
  return runCron(req, "過去投稿の取り込み", async () => {
    const r = await importHistory(100);
    return { imported: r.imported, suggested: r.suggested.length };
  });
}
