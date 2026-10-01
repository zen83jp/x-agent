import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "@/lib/slack/verify";

const secret = "test-secret";
const body = "payload=%7B%7D";
const now = 1_760_000_000;
const sign = (ts: number, b = body) =>
  "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${b}`).digest("hex");

describe("verifySlackSignature", () => {
  it("正しい署名を受け入れる", () => {
    expect(
      verifySlackSignature({ signingSecret: secret, rawBody: body, timestamp: String(now), signature: sign(now), nowSec: now }),
    ).toBe(true);
  });

  it("本文が改ざんされていれば拒否する", () => {
    expect(
      verifySlackSignature({ signingSecret: secret, rawBody: body + "x", timestamp: String(now), signature: sign(now), nowSec: now }),
    ).toBe(false);
  });

  it("5分より古いリクエストを拒否する", () => {
    const old = now - 301;
    expect(
      verifySlackSignature({ signingSecret: secret, rawBody: body, timestamp: String(old), signature: sign(old), nowSec: now }),
    ).toBe(false);
  });

  it("ヘッダーがなければ拒否する", () => {
    expect(verifySlackSignature({ signingSecret: secret, rawBody: body, timestamp: null, signature: null, nowSec: now })).toBe(false);
  });
});
