import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminRequest } from "@/lib/auth";
import { createDailyDrafts, createScheduledDrafts } from "@/lib/posts/daily";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({ dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(10).optional() });

/**
 * 投稿案の作成を手動で動かす（管理用）。`POST ?key=$ADMIN_SECRET`
 * 本文 `{ "dates": ["2026-10-04", "2026-10-05"] }` でその日付の分を作る。省略すると平日 9:00 と同じ範囲を作る。
 * 投稿はしない（【投稿承認】に出すだけ）。作成済みの日付は何もしない
 */
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: body.error.message }, { status: 400 });
  const now = new Date();
  if (!body.data.dates?.length) return NextResponse.json(await createScheduledDrafts(now));
  const results = [];
  for (const date of body.data.dates) results.push(await createDailyDrafts(now, date));
  return NextResponse.json({ results });
}
