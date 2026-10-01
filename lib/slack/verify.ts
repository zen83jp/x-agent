import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_AGE_SEC = 60 * 5;

/**
 * Slack のリクエスト署名を検証する。
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(args: {
  signingSecret: string;
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  nowSec?: number;
}): boolean {
  const { signingSecret, rawBody, timestamp, signature } = args;
  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_AGE_SEC) return false;

  const expected =
    "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
