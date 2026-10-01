import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { notifyAlert } from "@/lib/slack/client";
import { xApi } from "@/lib/x/client";
import { exchangeCode, saveTokens } from "@/lib/x/oauth";

export const dynamic = "force-dynamic";

type UsersMe = { data: { id: string; username: string; name: string } };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jar = await cookies();
  const state = jar.get("x_oauth_state")?.value;
  const verifier = jar.get("x_oauth_verifier")?.value;
  jar.delete({ name: "x_oauth_state", path: "/api/x/callback" });
  jar.delete({ name: "x_oauth_verifier", path: "/api/x/callback" });

  const error = url.searchParams.get("error");
  if (error) return new NextResponse(`認可がキャンセルされました: ${error}`, { status: 400 });

  const code = url.searchParams.get("code");
  if (!code || !state || !verifier || url.searchParams.get("state") !== state) {
    return new NextResponse("state が一致しません。/api/x/authorize からやり直してください", { status: 400 });
  }

  const tokens = await exchangeCode(code, verifier);
  const me = await xApi<UsersMe>("users.me", { accessToken: tokens.access_token });
  await saveTokens(me.data.id, tokens);
  await notifyAlert(`X の認可が完了しました: @${me.data.username}（${me.data.name}）`, "info");

  return new NextResponse(`認可完了: @${me.data.username}。このタブは閉じて大丈夫です。`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
