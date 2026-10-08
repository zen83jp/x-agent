import { NextResponse } from "next/server";
import { adminUnauthorized, isAdminRequest } from "@/lib/auth";
import { env } from "@/lib/env";
import { postMessage } from "@/lib/slack/client";
import { spentTodayUsd } from "@/lib/x/budget";
import { xApi } from "@/lib/x/client";

export const dynamic = "force-dynamic";

type UsersMe = { data: { id: string; username: string } };

/**
 * 疎通確認。X（ラッパー経由）→ 使用量記録 → Slack ボタン通知までを一通り動かす。
 * `Authorization: Bearer $ADMIN_SECRET` が必要。呼ぶたびに users.me の分だけ X API の費用がかかる。
 */
export async function GET(req: Request) {
  if (!isAdminRequest(req)) return adminUnauthorized(req);

  let xResult: string;
  try {
    const me = await xApi<UsersMe>("users.me");
    xResult = `OK @${me.data.username}`;
  } catch (e) {
    xResult = `NG ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
  const spent = await spentTodayUsd();
  const summary = `X: ${xResult}\n本日の X API 使用額（推定）: $${spent.toFixed(4)} / 上限 $${env().X_DAILY_BUDGET_USD}`;

  await postMessage({
    kind: "alert",
    text: `ヘルスチェック\n${summary}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*ヘルスチェック*\n${summary}` } },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "health_ack", text: { type: "plain_text", text: "テストOK" }, style: "primary" },
        ],
      },
    ],
  });

  return NextResponse.json({ x: xResult, spentTodayUsd: spent });
}
