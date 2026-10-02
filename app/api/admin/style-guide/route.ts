import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminRequest } from "@/lib/auth";
import { buildStyleGuideDraft } from "@/lib/style/build";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 文体ガイドの案を作る（管理用）。`POST ?key=$ADMIN_SECRET`、本文（任意）`{ "max": 300, "instructions": "…" }`
 * 過去投稿の取得（$0.001／件。100件で約$0.10）と Claude の呼び出しが発生する。結果は未承認で保存される。
 */
const bodySchema = z.object({
  max: z.number().int().min(5).max(500).default(100),
  instructions: z.string().max(5000).optional(),
});

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return new NextResponse("Forbidden", { status: 403 });
  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: body.error.message }, { status: 400 });
  const draft = await buildStyleGuideDraft(body.data.max, body.data.instructions);
  return NextResponse.json(draft);
}
