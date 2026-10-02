import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * post_drafts の review_status だけを状態に持つフェイク。
 * 「update … .eq(review_status, X)」は今の状態が X のときだけ更新して行を返す（実 DB の条件付き更新と同じ）。
 */
const state = {
  status: "awaiting_approval",
  topic_id: null as number | null,
  target_date: "2026-10-03" as string | null,
  scheduled_at: null as string | null,
};
let insertedPosts = 0;

function query(table: string) {
  let update: Record<string, unknown> | null = null;
  let required: string | null = null;
  let selecting = false;
  let single = false;
  const q = {
    single() {
      single = true;
      return q;
    },
    update(fields: Record<string, unknown>) {
      update = fields;
      return q;
    },
    insert() {
      if (table === "posts") insertedPosts++;
      return q;
    },
    upsert: () => q,
    select() {
      selecting = true;
      return q;
    },
    eq(col: string, value: unknown) {
      if (col === "review_status") required = String(value);
      return q;
    },
    lte: () => q,
    lt: () => q,
    order: () => q,
    then(resolve: (v: unknown) => void) {
      if (table !== "post_drafts") return resolve({ data: null, error: null });
      if (single && !update) return resolve({ data: { target_date: state.target_date, review_status: state.status }, error: null });
      if (update) {
        if (required && required !== state.status) return resolve({ data: [], error: null });
        state.status = String(update.review_status);
        if (typeof update.scheduled_at === "string") state.scheduled_at = update.scheduled_at;
        return resolve({ data: [{ id: 1, topic_id: state.topic_id }], error: null });
      }
      if (selecting && required === "approved") {
        return resolve({
          data: state.status === "approved" ? [{ id: 1, body: "本文", topic_id: null, scheduled_at: new Date(Date.now() - 60_000).toISOString() }] : [],
          error: null,
        });
      }
      return resolve({ data: [], error: null });
    },
  };
  return q;
}

vi.mock("@/lib/supabase", () => ({ db: () => ({ from: (t: string) => query(t) }) }));
const createPost = vi.fn(async () => ({ data: { id: "x-post-1" } }));
vi.mock("@/lib/x/client", () => ({ xApi: (...a: unknown[]) => createPost(...(a as [])) }));
vi.mock("@/lib/posts/approval", () => ({ refreshDraftApproval: vi.fn(async () => {}) }));
vi.mock("@/lib/posts/history", () => ({ addPipelinePost: vi.fn(async () => {}) }));
vi.mock("@/lib/posts/topics", () => ({ releaseTopic: vi.fn(async () => {}), markTopicUsed: vi.fn(async () => {}) }));
vi.mock("@/lib/slack/client", () => ({ notifyAlert: vi.fn(async () => {}) }));

const { approveDraft, rejectDraft } = await import("@/lib/posts/actions");
const { runPublish } = await import("@/lib/posts/publish");

describe("承認と投稿", () => {
  beforeEach(() => {
    state.status = "awaiting_approval";
    state.target_date = "2026-10-03";
    state.scheduled_at = null;
    insertedPosts = 0;
    createPost.mockClear();
  });

  it("前日に承認しても、投稿案の target_date のその時刻で予約する（今回の不具合の再現）", async () => {
    // 10/2（金）11:38 JST に、10/3（土）向けの案を 12:10 で承認
    const r = await approveDraft(1, "12:10", new Date("2026-10-02T02:38:00Z"));
    expect(state.scheduled_at).toBe("2026-10-03T03:10:00.000Z"); // 10/3 12:10 JST（10/2 12:10 ではない）
    expect(r.summary).toBe("承認: 10/3（土）12:10 に投稿予約");
  });

  it("20:30 も target_date の 20:30", async () => {
    await approveDraft(1, "20:30", new Date("2026-10-02T02:38:00Z"));
    expect(state.scheduled_at).toBe("2026-10-03T11:30:00.000Z");
  });

  it("投稿日の 7:30 より前なら、その日のどの枠でも承認できる", async () => {
    // 10/3（土）7:00 JST に 20:30 で承認
    await approveDraft(1, "20:30", new Date("2026-10-02T22:00:00Z"));
    expect(state.status).toBe("approved");
    expect(state.scheduled_at).toBe("2026-10-03T11:30:00.000Z");
  });

  it("承認締切（投稿日の 7:30）を過ぎた承認は受け付けず、期限切れにする（12:10・20:30 の枠も）", async () => {
    // 10/3（土）8:00 JST に 20:30 で承認しようとした
    const r = await approveDraft(1, "20:30", new Date("2026-10-02T23:00:00Z"));
    expect(r.summary).toBe("期限切れのため投稿されません");
    expect(state.status).toBe("expired");
    expect(state.scheduled_at).toBeNull();
  });

  it("target_date のない古い案は、次に来るその時刻で予約する", async () => {
    state.target_date = null;
    await approveDraft(1, "07:30", new Date("2026-10-03T00:00:00Z")); // 10/3 9:00 JST
    expect(state.scheduled_at).toBe("2026-10-03T22:30:00.000Z"); // 10/4 7:30 JST
  });

  it("二重押下でも承認は1回だけ", async () => {
    const [a, b] = await Promise.all([approveDraft(1, "07:30"), approveDraft(1, "12:10")]);
    expect([a.summary, b.summary].filter((s) => s.startsWith("承認"))).toHaveLength(1);
    expect(state.status).toBe("approved");
  });

  it("承認後の却下は何もしない", async () => {
    await approveDraft(1, "07:30");
    expect((await rejectDraft(1)).summary).toBe("処理済みのため何もしませんでした");
  });

  it("承認されていない案は投稿しない", async () => {
    await runPublish();
    expect(createPost).not.toHaveBeenCalled();
  });

  it("予定時刻を過ぎた承認済みの案を1回だけ投稿する（同時に2回動いても）", async () => {
    state.status = "approved";
    await Promise.all([runPublish(), runPublish()]);
    expect(createPost).toHaveBeenCalledTimes(1);
    expect(insertedPosts).toBe(1);
    expect(state.status).toBe("posted");
  });

  it("X への投稿に失敗したら post_failed にして、再投稿しない", async () => {
    state.status = "approved";
    createPost.mockRejectedValueOnce(new Error("X API 503"));
    await runPublish();
    expect(state.status).toBe("post_failed");
    await runPublish();
    expect(createPost).toHaveBeenCalledTimes(1);
  });
});
