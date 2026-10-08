import { beforeAll, describe, expect, it, vi } from "vitest";

const CRON = "cron-secret-for-test-0123456789";
const ADMIN = "admin-secret-for-test-0123456789";

beforeAll(() => {
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("ADMIN_SECRET", ADMIN);
});

const weekly = vi.fn(async () => ({ today: "2026-10-08", created: [], failed: [], remaining: 0 }));
vi.mock("@/lib/posts/daily", () => ({ createWeeklyDrafts: () => weekly(), createMissingDrafts: vi.fn() }));
const poll = vi.fn(async () => ({ status: "ok" }));
vi.mock("@/lib/dm/poll", () => ({ pollDms: () => poll() }));
vi.mock("@/lib/slack/client", () => ({ notifyAlert: vi.fn() }));

const auth = await import("@/lib/auth");
const cronDrafts = await import("@/app/api/cron/post-drafts/route");
const cronPoll = await import("@/app/api/cron/dm-poll/route");
const adminDrafts = await import("@/app/api/admin/post-drafts/route");

const req = (url: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://x-agent-rust.vercel.app${url}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe("Cron の認証（Vercel は Authorization: Bearer <CRON_SECRET> を付けて呼ぶ）", () => {
  it("Vercel と同じ形式なら処理に進む（投稿案の作成・DM の取得）", async () => {
    const r1 = await cronDrafts.GET(req("/api/cron/post-drafts", { authorization: `Bearer ${CRON}` }));
    expect(r1.status).toBe(200);
    expect(weekly).toHaveBeenCalledTimes(1);
    const r2 = await cronPoll.GET(req("/api/cron/dm-poll", { authorization: `Bearer ${CRON}` }));
    expect(r2.status).toBe(200);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("?key= や ADMIN_SECRET では通さない", async () => {
    expect((await cronDrafts.GET(req(`/api/cron/post-drafts?key=${CRON}`))).status).toBe(403);
    expect((await cronDrafts.GET(req("/api/cron/post-drafts", { authorization: `Bearer ${ADMIN}` }))).status).toBe(403);
    expect(auth.isCronRequest(req("/x", { authorization: CRON }))).toBe(false); // Bearer なし
  });
});

describe("管理用 API の認証（Authorization: Bearer <ADMIN_SECRET>）", () => {
  it("ヘッダーで渡せば通る", async () => {
    const r = await adminDrafts.POST(req("/api/admin/post-drafts", { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, "POST"));
    expect(r.status).toBe(200);
  });

  it("?key= は廃止。401 で、ヘッダーで渡すよう案内する（正しい合言葉でも通さない）", async () => {
    const r = await adminDrafts.POST(req(`/api/admin/post-drafts?key=${ADMIN}`, {}, "POST"));
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error).toContain("?key= での認証は廃止しました");
    expect(body.error).toContain("Authorization: Bearer <ADMIN_SECRET>");
    expect(JSON.stringify(body)).not.toContain(ADMIN);
  });

  it("CRON_SECRET では通さない", () => {
    expect(auth.isAdminRequest(req("/x", { authorization: `Bearer ${CRON}` }))).toBe(false);
  });
});

describe("X の認可ページ（Basic 認証）", () => {
  it("パスワードが ADMIN_SECRET なら通る（ユーザー名は空でも何でもよい）", () => {
    expect(auth.isAdminBasic(req("/api/x/authorize", { authorization: basic("", ADMIN) }))).toBe(true);
    expect(auth.isAdminBasic(req("/api/x/authorize", { authorization: basic("admin", ADMIN) }))).toBe(true);
  });

  it("違うパスワード・Bearer・?key= では通らない", () => {
    expect(auth.isAdminBasic(req("/api/x/authorize", { authorization: basic("", "wrong") }))).toBe(false);
    expect(auth.isAdminBasic(req("/api/x/authorize", { authorization: `Bearer ${ADMIN}` }))).toBe(false);
    expect(auth.isAdminBasic(req(`/api/x/authorize?key=${ADMIN}`))).toBe(false);
  });

  it("合言葉がなければ 401 でブラウザにパスワードを聞かせる", () => {
    const r = auth.basicChallenge();
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Basic");
  });
});
