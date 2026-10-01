import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/x/budget", () => ({
  assertWithinBudget: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/x/oauth", () => ({
  getValidAccessToken: vi.fn(async () => "token"),
}));

const { assertNoUrlInPost, UrlInPostError, xApi } = await import("@/lib/x/client");
const budget = await import("@/lib/x/budget");

const URL_TEXT = "応募はこちらから https://taskar.online/staff/";

describe("assertNoUrlInPost", () => {
  it("URL 入りの投稿は止める", () => {
    expect(() => assertNoUrlInPost("tweets.create", { text: URL_TEXT })).toThrow(UrlInPostError);
  });

  it("URL なしの投稿は通す", () => {
    expect(() => assertNoUrlInPost("tweets.create", { text: "月10時間から使えます" })).not.toThrow();
  });

  it("URL 入りの DM 送信は止めない", () => {
    expect(() => assertNoUrlInPost("dm.send", { text: URL_TEXT })).not.toThrow();
  });
});

describe("xApi の URL チェック", () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ data: { dm_conversation_id: "c1", dm_event_id: "e1" } }, { status: 201 }),
  );

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("URL 入りの投稿は予算チェックも X 呼び出しもせずに止める", async () => {
    await expect(xApi("tweets.create", { body: { text: URL_TEXT } })).rejects.toThrow(UrlInPostError);
    expect(budget.assertWithinBudget).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("URL 入りの DM は送信し、使用量を記録する", async () => {
    await xApi("dm.send", { params: { dm_conversation_id: "c1" }, body: { text: URL_TEXT } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.x.com/2/dm_conversations/c1/messages");
    expect(budget.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "POST /2/dm_conversations/:dm_conversation_id/messages", estCostUsd: 0.015 }),
    );
  });
});
