import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function freshEnv() {
  vi.resetModules();
  return (await import("@/lib/env")).env;
}

describe("env", () => {
  it("読んだ変数だけを検証する（未設定の X 変数があっても Slack 変数は読める）", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "abc");
    vi.stubEnv("X_CLIENT_ID", "");
    const env = await freshEnv();
    expect(env().SLACK_SIGNING_SECRET).toBe("abc");
    expect(() => env().X_CLIENT_ID).toThrow("X_CLIENT_ID");
  });

  it("型変換と形式チェックをする", async () => {
    vi.stubEnv("X_DAILY_BUDGET_USD", "3");
    vi.stubEnv("SLACK_BOT_TOKEN", "not-a-bot-token");
    const env = await freshEnv();
    expect(env().X_DAILY_BUDGET_USD).toBe(3);
    expect(() => env().SLACK_BOT_TOKEN).toThrow("SLACK_BOT_TOKEN");
  });
});
