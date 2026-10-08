import { beforeEach, describe, expect, it, vi } from "vitest";

/** 投稿案の修正: 最初の修正のときだけ【原文】をスレッドに残し、結果と要確認をスレッドに出す */
let revisionCount = 1;
function query(table: string) {
  let isUpdate = false;
  const q = {
    insert: () => q,
    update() {
      isUpdate = true;
      return q;
    },
    select: () => q,
    eq: () => q,
    lte: () => q,
    order: () => q,
    single: () => Promise.resolve({ data: { id: revisionCount }, error: null }),
    then(resolve: (v: unknown) => void) {
      if (table === "post_draft_revisions" && !isUpdate) {
        return resolve({ data: Array.from({ length: revisionCount }, (_, i) => ({ id: i + 1, instruction: `指示${i + 1}` })), error: null });
      }
      if (table === "post_drafts" && isUpdate) return resolve({ data: [{ id: 5 }], error: null });
      return resolve({ data: null, error: null });
    },
  };
  return q;
}
vi.mock("@/lib/supabase", () => ({ db: () => ({ from: (t: string) => query(t) }) }));
const say = vi.fn(async (_a: { text: string }) => {});
vi.mock("@/lib/slack/client", () => ({ postThreadReply: (a: { text: string }) => say(a) }));
vi.mock("@/lib/posts/approval", () => ({ refreshDraftApproval: vi.fn(async () => {}), loadDraft: vi.fn() }));
const writeAndReview = vi.fn();
vi.mock("@/lib/posts/writer", () => ({ writeAndReview: (...a: unknown[]) => writeAndReview(...a) }));

const { reviseDraft } = await import("@/lib/posts/revise");
const draft = {
  id: 5, kind: "business" as const, slot_time: "12:10" as const, target_date: "2026-10-14", body: "元の本文です。", reason: null,
  review_note: null, review_status: "awaiting_approval", topic_id: null, day_context: null, scheduled_at: null,
  slack_channel: "C1", slack_ts: "1.0", post_topics: null,
};

describe("投稿案の修正（スレッド）", () => {
  beforeEach(() => {
    say.mockClear();
    writeAndReview.mockReset();
  });

  it("最初の修正では【原文】を先に投稿し、修正結果と要確認をスレッドに出す", async () => {
    revisionCount = 1;
    writeAndReview.mockResolvedValue({ body: "新しい本文です。", reason: "r", theme: "t", review: { verdict: "pass", issues: [], warnings: ["同じ週の案とテーマが同じです"] } });
    await reviseDraft(draft, "2.0", "もっと短く");
    const texts = say.mock.calls.map((c) => c[0].text);
    expect(texts[0]).toBe("【原文】\n元の本文です。");
    expect(texts[1]).toContain("修正しました（1回目）");
    expect(texts[1]).toContain("要確認");
    expect(texts[1]).toContain("同じ週の案とテーマが同じです");
    expect(texts[2]).toBe("新しい本文です。");
  });

  it("2回目以降の修正では【原文】を繰り返さない", async () => {
    revisionCount = 2;
    writeAndReview.mockResolvedValue({ body: "さらに新しい本文です。", reason: "r", theme: "t", review: { verdict: "pass", issues: [], warnings: [] } });
    await reviseDraft({ ...draft, body: "新しい本文です。" }, "3.0", "もう少し柔らかく");
    const texts = say.mock.calls.map((c) => c[0].text);
    expect(texts.some((t) => t.startsWith("【原文】"))).toBe(false);
    expect(texts[0]).toBe("修正しました（2回目）。上のメッセージを最新の案に差し替えました。");
  });

  it("作り直しに失敗したら「修正できませんでした」とスレッドに出す（【原文】は残す）", async () => {
    revisionCount = 1;
    writeAndReview.mockResolvedValue({ failed: "審査を通る案を作れませんでした" });
    await reviseDraft(draft, "4.0", "もっと短く");
    const texts = say.mock.calls.map((c) => c[0].text);
    expect(texts[0]).toBe("【原文】\n元の本文です。");
    expect(texts[1]).toContain("修正できませんでした");
  });
});
