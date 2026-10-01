import { describe, expect, it } from "vitest";
import { pkceChallenge } from "@/lib/x/oauth";
import { X_OPS, actualUnits, containsUrl, estimateUnits } from "@/lib/x/pricing";

describe("pkceChallenge", () => {
  // 期待値は `printf %s <verifier> | openssl dgst -sha256 -binary | base64url` で算出
  it("SHA-256 の base64url（パディングなし）を返す", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mJ92K1hDYsYfXabOlXNLB4OtsxTvYDKLPjPdsg")).toBe(
      "DkH6Z6uN0WRa8RVfmIXdRSBSNjdlcedMUDN-hm8C5qY",
    );
  });
});

describe("pricing", () => {
  it("max_results を見積もり件数に使う", () => {
    expect(estimateUnits(X_OPS["dm_events.list"], { max_results: 10 })).toBe(10);
    expect(estimateUnits(X_OPS["dm_events.list"])).toBe(1);
    expect(estimateUnits(X_OPS["dm.send"], { max_results: 10 })).toBe(1);
  });

  it("実際に返ってきた件数で課金件数を数える", () => {
    expect(actualUnits(X_OPS["dm_events.list"], { data: [{}, {}, {}] })).toBe(3);
    expect(actualUnits(X_OPS["dm_events.list"], { meta: { result_count: 0 } })).toBe(0);
    expect(actualUnits(X_OPS["users.me"], { data: { id: "1" } })).toBe(1);
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
    ["tweets.lookup.others", 0.005],
    ["tweets.lookup.own", 0.001],
    ["users.me", 0.01],
    ["dm_events.list", 0.01],
    ["tweets.create", 0.015],
    ["dm.send", 0.015],
  ] as const)("%s = $%s／件", (op, cost) => expect(X_OPS[op].unitCostUsd).toBe(cost));
});
