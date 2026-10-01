import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Supabase の最小限のフェイク。dm_messages の send_status だけを状態として持ち、
 * 「update … .eq(id) .in(send_status, [...]) .select()」で条件に合ったときだけ行を返す（実 DB の条件付き更新と同じ振る舞い）。
 */
const state = { send_status: "pending" as string };
const row = {
  id: 7,
  thread_id: 3,
  category: "faq",
  classification: null,
  draft_reply: "返信案です",
  decline_reply: null,
  dm_threads: { x_conversation_id: "111-222", x_user_id: "111", x_username: "yamada", x_name: "山田" },
};

function query() {
  let update: Record<string, unknown> | null = null;
  let allowed: string[] | null = null;
  const q = {
    update(fields: Record<string, unknown>) {
      update = fields;
      return q;
    },
    insert: () => q,
    eq: () => q,
    in(_col: string, values: string[]) {
      allowed = values;
      return q;
    },
    select: () => q,
    then(resolve: (v: unknown) => void) {
      if (update && allowed) {
        // 条件付き更新（処理権の取得）
        if (allowed.includes(state.send_status)) {
          state.send_status = String(update.send_status);
          return resolve({ data: [row], error: null });
        }
        return resolve({ data: [], error: null });
      }
      if (update?.send_status) state.send_status = String(update.send_status);
      return resolve({ data: null, error: null });
    },
  };
  return q;
}

vi.mock("@/lib/supabase", () => ({ db: () => ({ from: () => query() }) }));
const sendDm = vi.fn(async () => "evt-1");
vi.mock("@/lib/x/dm", () => ({ sendDm: (...args: unknown[]) => sendDm(...(args as [])) }));
vi.mock("@/lib/slack/client", () => ({ openModal: vi.fn() }));
vi.mock("@/lib/dm/approval", () => ({ markApprovalDone: vi.fn() }));

const { dmActionHandlers } = await import("@/lib/dm/actions");
const ctx = { userId: "U1", value: "7", channel: "C1", messageTs: "1.0" };

describe("DM 承認ボタン", () => {
  beforeEach(() => {
    state.send_status = "pending";
    sendDm.mockClear();
  });

  it("[送信] で返信案を送り、sent になる", async () => {
    const res = await dmActionHandlers.dm_send(ctx);
    expect(res.summary).toBe("送信しました");
    expect(sendDm).toHaveBeenCalledWith("111-222", "返信案です");
    expect(state.send_status).toBe("sent");
  });

  it("二重押下（同時2回）でも1通しか送らない", async () => {
    const results = await Promise.all([dmActionHandlers.dm_send(ctx), dmActionHandlers.dm_send(ctx)]);
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.summary).sort()).toEqual(["処理済みのため何もしませんでした", "送信しました"]);
  });

  it("送信済みのあとに [送らない] を押しても何もしない", async () => {
    await dmActionHandlers.dm_send(ctx);
    const res = await dmActionHandlers.dm_skip(ctx);
    expect(res.summary).toBe("処理済みのため何もしませんでした");
    expect(state.send_status).toBe("sent");
  });

  it("X への送信に失敗したら failed にして、もう一度押せば再送できる", async () => {
    sendDm.mockRejectedValueOnce(new Error("X API 503"));
    await expect(dmActionHandlers.dm_send(ctx)).rejects.toThrow("503");
    expect(state.send_status).toBe("failed");
    await dmActionHandlers.dm_send(ctx);
    expect(state.send_status).toBe("sent");
  });
});
