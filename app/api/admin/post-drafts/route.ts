import { NextResponse } from "next/server";
import { z } from "zod";
import { adminUnauthorized, isAdminRequest } from "@/lib/auth";
import { createMissingDrafts, createWeeklyDrafts } from "@/lib/posts/daily";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({ dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(20).optional() });

/**
 * 投稿案の作成を手動で動かす（管理用）。`POST`、`Authorization: Bearer $ADMIN_SECRET`（scripts/post-drafts.sh から呼ぶ）
 * 本文を省略すると、週の生成と同じ範囲（翌日〜翌週の日曜）のまだ案が無い枠を作る。
 * `{ "dates": ["2026-10-10"] }` でその日付の、まだ案が無い枠だけを作る。
 * 1回の実行は約3分で区切る。返り値の remaining が 0 になるまで、繰り返し実行する。
 * 投稿はしない（【投稿承認】に出すだけ）。
 */
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return adminUnauthorized(req);
  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: body.error.message }, { status: 400 });
  const result = body.data.dates?.length
    ? await createMissingDrafts(body.data.dates)
    : await createWeeklyDrafts({ force: true });
  return NextResponse.json(result);
}
