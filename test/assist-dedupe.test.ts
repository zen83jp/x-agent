import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Slack の再送（同じ投稿のイベントが2回届く）でも、Claude を呼ぶ前に DB の一意制約で弾かれることの確認。
 * dm_assists.slack_ts / dm_assist_revisions.slack_ts の insert が 23505（一意制約違反）を返す状況を作る。
 */
let insertError: { code: string } | null = null;

function query() {
  const q = {
    insert: () => q,
    update: () => q,
    select: () => q,
    eq: () => q,
    order: () => q,
    single: () => Promise.resolve({ data: insertError ? null : { id: 1 }, error: insertError }),
    then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
  };
  return q;
}

vi.mock("@/lib/supabase", () => ({ db: () => ({ from: () => query() }) }));
const classifyDm = vi.fn();
const draftReply = vi.fn();
vi.mock("@/lib/dm/generate", () => ({
  classifyDm: (...a: unknown[]) => classifyDm(...a),
  draftReply: (...a: unknown[]) => draftReply(...a),
  NO_DRAFT_CATEGORIES: ["spam", "escalate"],
  replyTextFor: () => null,
}));
const generateJson = vi.fn();
vi.mock("@/lib/claude", () => ({ generateJson: (...a: unknown[]) => generateJson(...a), loadPrompt: vi.fn() }));
const postThreadReply = vi.fn();
vi.mock("@/lib/slack/client", () => ({
  fetchChannelMessage: vi.fn(async () => ({ text: "<@U0BOT> 電話対応もお願いできますか？" })),
  postThreadReply: (...a: unknown[]) => postThreadReply(...a),
  downloadSlackFile: vi.fn(),
}));
vi.mock("@/lib/dm/leads", () => ({ isLeadCategory: () => false, upsertLead: vi.fn(), normalizeUsername: (u: string) => u }));

const { startAssist, reviseAssist } = await import("@/lib/dm/assist");

describe("Slack の再送と二重処理", () => {
  beforeEach(() => {
    insertError = null;
    classifyDm.mockReset();
    draftReply.mockReset();
    generateJson.mockReset();
    postThreadReply.mockReset();
  });

  it("同じ投稿（ts）がすでに処理済みなら、Claude を呼ばずに終わる（返信アシスタントの新しい依頼）", async () => {
    insertError = { code: "23505" };
    await startAssist({ channel: "C1", rootTs: "1790926761.946829", messageTs: "1790926761.946829", text: "<@U0BOT> 電話対応もお願いできますか？" });
    expect(classifyDm).not.toHaveBeenCalled();
    expect(draftReply).not.toHaveBeenCalled();
    expect(generateJson).not.toHaveBeenCalled();
    expect(postThreadReply).not.toHaveBeenCalled();
  });

  it("同じ指示（ts）がすでに処理済みなら、作り直しも Claude を呼ばずに終わる", async () => {
    insertError = { code: "23505" };
    await reviseAssist(
      { id: 1, slack_channel: "C1", slack_ts: "1.0", extracted: null, classification: null, reply: null },
      "2.0",
      "もっと短く",
    );
    expect(draftReply).not.toHaveBeenCalled();
    expect(postThreadReply).not.toHaveBeenCalled();
  });

  it("初めての投稿なら処理に進む（分類を呼ぶ）", async () => {
    classifyDm.mockResolvedValue({ ok: false, error: "テスト" });
    await startAssist({ channel: "C1", rootTs: "3.0", messageTs: "3.0", text: "<@U0BOT> 電話対応もお願いできますか？" });
    expect(classifyDm).toHaveBeenCalledTimes(1);
  });
});
