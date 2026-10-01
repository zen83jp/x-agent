import { describe, expect, it } from "vitest";
import { pkceChallenge } from "@/lib/x/oauth";
import { costOf, dedupe, utcDay } from "@/lib/x/billing";
import { RESOURCE_COST_USD, X_OPS, containsUrl, estimateCostUsd } from "@/lib/x/pricing";

describe("pkceChallenge", () => {
  // 期待値は `printf %s <verifier> | openssl dgst -sha256 -binary | base64url` で算出
  it("SHA-256 の base64url（パディングなし）を返す", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mJ92K1hDYsYfXabOlXNLB4OtsxTvYDKLPjPdsg")).toBe(
      "DkH6Z6uN0WRa8RVfmIXdRSBSNjdlcedMUDN-hm8C5qY",
    );
  });
});

describe("pricing", () => {
  it("読み取りは max_results 件分を最悪値として見積もる", () => {
    expect(estimateCostUsd(X_OPS["dm_events.list"], { max_results: 10 })).toBeCloseTo(0.2);
    expect(estimateCostUsd(X_OPS["users.me"])).toBeCloseTo(0.01);
    expect(estimateCostUsd(X_OPS["dm.send"], { max_results: 10 })).toBe(0.015);
  });

  it("DM イベント取得はイベントと展開されたユーザーを課金対象として列挙する", () => {
    const def = X_OPS["dm_events.list"].billing;
    expect(
      def.extract({ data: [{ id: "e1" }, { id: "e2" }], includes: { users: [{ id: "u1" }] } }),
    ).toEqual([
      { type: "dm_event", id: "e1" },
      { type: "dm_event", id: "e2" },
      { type: "user", id: "u1" },
    ]);
    expect(def.extract({ meta: { result_count: 0 } })).toEqual([]);
  });

  it("users.me は単体のユーザーを1件として数える", () => {
    expect(X_OPS["users.me"].billing.extract({ data: { id: "1" } })).toEqual([{ type: "user", id: "1" }]);
  });
});

describe("billing", () => {
  it("同じレスポンス内の重複を除く", () => {
    expect(
      dedupe([
        { type: "user", id: "u1" },
        { type: "user", id: "u1" },
        { type: "dm_event", id: "u1" },
      ]),
    ).toHaveLength(2);
  });

  it("リソース種別ごとの単価で合計する", () => {
    expect(
      costOf([
        { type: "dm_event", id: "e1" },
        { type: "user", id: "u1" },
        { type: "post", id: "p1" },
        { type: "own_post", id: "p2" },
      ]),
    ).toBeCloseTo(0.026);
  });

  it("UTC の日付で区切る（JST 8:59 は前日扱い）", () => {
    expect(utcDay(new Date("2026-10-01T23:59:00Z"))).toBe("2026-10-01");
    expect(utcDay(new Date("2026-10-02T00:00:00Z"))).toBe("2026-10-02");
  });
});

describe("containsUrl", () => {
  it.each([
    "詳しくは https://example.com で",
    "www.color-s.net をご覧ください",
    "taskar.online から応募できます",
    "color-s.co.jp",
  ])("URL を検出する: %s", (t) => expect(containsUrl(t)).toBe(true));

  it.each(["月10時間から使えます。", "料金は25,000円です", "v2.0 にしました"])("URL ではない: %s", (t) =>
    expect(containsUrl(t)).toBe(false),
  );
});

describe("単価（2026年9月末時点の公表値）", () => {
  it.each([
    ["post", 0.005],
    ["own_post", 0.001],
    ["user", 0.01],
    ["dm_event", 0.01],
  ] as const)("読み取り %s = $%s／件", (type, cost) => expect(RESOURCE_COST_USD[type]).toBe(cost));

  it.each([
    ["tweets.create", 0.015],
    ["dm.send", 0.015],
  ] as const)("%s = $%s／リクエスト", (op, cost) => expect(estimateCostUsd(X_OPS[op])).toBe(cost));
});
