import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminRequest } from "@/lib/auth";
import { createDailyDrafts } from "@/lib/posts/daily";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/**
 * 投稿案の作成を手動で動かす（管理用・動作確認用）。`POST ?key=$ADMIN_SECRET`、本文（任意）`{ "date": "2026-10-03" }`
 * 投稿はしない（【投稿承認】に出すだけ）。同じ日付の案がすでにあれば何もしない
 */
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return new NextResponse("Forbidden", { status: 403 });
  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: body.error.message }, { status: 400 });
  return NextResponse.json(await createDailyDrafts(new Date(), body.data.date));
}
