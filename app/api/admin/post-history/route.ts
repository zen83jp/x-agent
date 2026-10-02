import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminRequest } from "@/lib/auth";
import { importHistory } from "@/lib/posts/history";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({ max: z.number().int().min(5).max(500).default(300) });

/**
 * 過去投稿を保管庫に取り込む（管理用）。`POST ?key=$ADMIN_SECRET`、本文（任意）`{ "max": 300 }`
 * $0.001／件（同じ投稿は UTC 日内で1回だけ課金）。作り話の候補（キーワード判定）を返す。確定は代表の確認後に行う
 */
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return new NextResponse("Forbidden", { status: 403 });
  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: body.error.message }, { status: 400 });
  return NextResponse.json(await importHistory(body.data.max));
}
