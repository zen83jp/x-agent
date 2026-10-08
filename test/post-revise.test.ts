import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 投稿案の修正（スレッド）のテスト。DB は投稿案1件と、その修正の記録だけを持つフェイク。
 */
type Rev = { id: number; instruction: string; body: string | null; previous_body: string | null };
const state = { revisions: [] as Rev[], draftBody: "", status: "awaiting_approval", originalSaved: null as string | null };

function query(table: string) {
  let op: "select" | "insert" | "update" = "select";
  let payload: Record<string, unknown> = {};
  const filters: Record<string, unknown> = {};
  const q = {
    insert(p: Record<string, unknown>) {
      op = "insert";
      payload = p;
      return q;
    },
    update(p: Record<string, unknown>) {
      op = "update";
      payload = p;
      return q;
    },
    select: () => q,
    eq(col: string, v: unknown) {
      filters[col] = v;
      return q;
    },
    is: () => q,
    lte: () => q,
    order: () => q,
    single() {
      if (table === "post_draft_revisions" && op === "insert") {
        const id = state.revisions.length + 1;
        state.revisions.push({ id, instruction: String(payload.instruction), body: null, previous_body: (payload.previous_body as string) ?? null });
        return Promise.resolve({ data: { id }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    then(resolve: (v: unknown) => void) {
      if (table === "post_draft_revisions" && op === "select") return resolve({ data: state.revisions.map((r) => ({ ...r })), error: null });
      if (table === "post_draft_revisions" && op === "update") {
        const r = state.revisions.find((x) => x.id === filters.id);
        if (r && typeof payload.body === "string") r.body = payload.body;
        return resolve({ data: null, error: null });
      }
      if (table === "post_drafts" && op === "update") {
        if (typeof payload.original_body === "string") state.originalSaved = payload.original_body;
        if (typeof payload.body === "string") {
          if (state.status !== "awaiting_approval") return resolve({ data: [], error: null });
          state.draftBody = payload.body;
        }
        return resolve({ data: [{ id: 5 }], error: null });
      }
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
const checkWithoutWriting = vi.fn(async (_c: unknown, _b: string, _t: string) => ({ fatal: [] as string[], review: { verdict: "pass", issues: [], warnings: [] as string[] } }));
vi.mock("@/lib/posts/writer", () => ({
  writeAndReview: (...a: unknown[]) => writeAndReview(...a),
  checkWithoutWriting: (c: unknown, b: string, t: string) => checkWithoutWriting(c, b, t),
}));

const { reviseDraft, instructionsSinceLastRevert, previousVersion } = await import("@/lib/posts/revise");

const ORIGINAL = "元の本文です。";
const base = {
  id: 5, kind: "business" as const, slot_time: "12:10" as const, target_date: "2026-10-14", body: ORIGINAL, original_body: ORIGINAL as string | null,
  theme: "任せ方", reason: null, review_note: null, review_status: "awaiting_approval", topic_id: null, day_context: null, scheduled_at: null,
  slack_channel: "C1", slack_ts: "1.0", post_topics: null,
};
let ts = 1;
const texts = () => say.mock.calls.map((c) => c[0].text);
const draft = () => ({ ...base, body: state.draftBody, review_status: state.status });
const revise = (instruction: string, d = draft()) => reviseDraft(d, String(++ts), instruction);

describe("投稿案の修正（スレッド）", () => {
  beforeEach(() => {
    state.revisions = [];
    state.draftBody = ORIGINAL;
    state.status = "awaiting_approval";
    state.originalSaved = null;
    say.mockClear();
    writeAndReview.mockReset();
    checkWithoutWriting.mockClear();
    writeAndReview.mockImplementation(async (ctx: { revision: { instructions: string[] } }) => ({
      body: `修正後（${ctx.revision.instructions.join("＋")}）`, reason: "r", theme: "t", review: { verdict: "pass", issues: [], warnings: [] },
    }));
  });

  it("最初の修正では【原文】を先に投稿し、修正結果をスレッドに出す。修正前の本文も保存する", async () => {
    await revise("もっと短く");
    expect(texts()[0]).toBe("【原文】\n元の本文です。");
    expect(texts()[1]).toContain("修正しました（1回目）");
    expect(texts()[2]).toBe("修正後（もっと短く）");
    expect(state.revisions[0]!.previous_body).toBe(ORIGINAL);
  });

  it("2回目以降の修正では【原文】を繰り返さない", async () => {
    await revise("もっと短く");
    say.mockClear();
    await revise("もう少し柔らかく");
    expect(texts().some((t) => t.startsWith("【原文】"))).toBe(false);
    expect(texts()[0]).toBe("修正しました（2回目）。上のメッセージを最新の案に差し替えました。");
  });

  it("「原文に戻して」は Claude を呼ばずに原文へ戻す（機械チェックは通す）", async () => {
    await revise("もっと短く");
    say.mockClear();
    writeAndReview.mockClear();
    await revise("原文に戻してください");
    expect(writeAndReview).not.toHaveBeenCalled();
    expect(checkWithoutWriting).toHaveBeenCalledWith(expect.anything(), ORIGINAL, "任せ方");
    expect(state.draftBody).toBe(ORIGINAL);
    expect(texts()[0]).toBe("原文に戻しました。上のメッセージを差し替えました。");
    expect(texts()[1]).toBe(ORIGINAL);
  });

  it("「1つ前に戻して」は直前の修正版に戻す", async () => {
    await revise("もっと短く");
    await revise("もう少し柔らかく");
    say.mockClear();
    await revise("ひとつ前に戻して");
    expect(state.draftBody).toBe("修正後（もっと短く）");
    expect(texts()[0]).toBe("1つ前の案に戻しました。上のメッセージを差し替えました。");
  });

  it("「戻して」だけは戻さず、言い方を案内する", async () => {
    await revise("もっと短く");
    say.mockClear();
    await revise("戻して");
    expect(state.draftBody).toBe("修正後（もっと短く）");
    expect(texts()[0]).toContain("『原文に戻して』");
    expect(texts()[0]).toContain("『1つ前に戻して』");
  });

  it("戻した要確認はスレッドに出し、URL などがあれば戻さない", async () => {
    await revise("もっと短く");
    checkWithoutWriting.mockResolvedValueOnce({ fatal: [], review: { verdict: "pass", issues: [], warnings: ["同じ週の案とテーマが同じです"] } });
    say.mockClear();
    await revise("原文に戻して");
    expect(texts()[0]).toContain("要確認");
    expect(texts()[0]).toContain("同じ週の案とテーマが同じです");

    await revise("もう一度短く");
    checkWithoutWriting.mockResolvedValueOnce({ fatal: ["URL（またはドメイン名）が含まれています"], review: { verdict: "pass", issues: [], warnings: [] } });
    say.mockClear();
    const before = state.draftBody;
    await revise("原文に戻して");
    expect(state.draftBody).toBe(before);
    expect(texts()[0]).toContain("原文に戻せませんでした");
  });

  it("戻した後の修正は、戻す前の指示を引き継がない", async () => {
    await revise("もっと短く");
    await revise("原文に戻して");
    await revise("締めを変えて");
    expect(state.draftBody).toBe("修正後（締めを変えて）");
  });

  it("原文が保存されていない古い案は戻せないと伝える", async () => {
    await revise("もっと短く", { ...draft(), original_body: null });
    say.mockClear();
    await revise("原文に戻して", { ...draft(), original_body: null });
    expect(texts()[0]).toBe("原文が保存されていないため戻せません。");
  });

  it("原文が未保存の案は、最初の修正のときに今の本文を原文として保存する", async () => {
    await revise("もっと短く", { ...draft(), original_body: null });
    expect(state.originalSaved).toBe(ORIGINAL);
  });

  it("承認済みの案は、修正も「戻す」も受け付けない（本文は変えない）", async () => {
    state.status = "approved";
    await revise("原文に戻して");
    expect(texts()).toEqual(["承認待ちではないため修正できません（承認済み・却下・期限切れ）。"]);
    expect(state.draftBody).toBe(ORIGINAL);
  });

  it("修正に失敗したら「修正できませんでした」とスレッドに出す（【原文】は残す）", async () => {
    writeAndReview.mockResolvedValue({ failed: "審査を通る案を作れませんでした" });
    await revise("もっと短く");
    expect(texts()[0]).toBe("【原文】\n元の本文です。");
    expect(texts()[1]).toContain("修正できませんでした");
  });
});

describe("戻すときの補助", () => {
  const rows = [
    { id: 1, instruction: "もっと短く", body: "A", previous_body: "O" },
    { id: 2, instruction: "原文に戻して", body: "O", previous_body: "A" },
    { id: 3, instruction: "戻して", body: null, previous_body: "O" },
    { id: 4, instruction: "締めを変えて", body: "B", previous_body: "O" },
  ];
  it("書き手に渡す指示は、最後に戻した後の通常の修正だけ", () => {
    expect(instructionsSinceLastRevert(rows)).toEqual(["締めを変えて"]);
  });
  it("1つ前は、今回より前の、本文が変わった最新の修正の修正前の本文", () => {
    expect(previousVersion(rows, 5)).toBe("O");
    expect(previousVersion(rows, 2)).toBe("O");
    expect(previousVersion([], 1)).toBeNull();
  });
});
