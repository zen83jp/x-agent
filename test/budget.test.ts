import { describe, expect, it } from "vitest";
import { isOverBudget, jstDate, jstDayStart } from "@/lib/x/budget";

describe("jstDayStart", () => {
  it("JST 0:00 ちょうどの前後で日付が切り替わる", () => {
    // 2026-10-01 23:59 JST = 2026-10-01T14:59Z
    expect(jstDayStart(new Date("2026-10-01T14:59:00Z")).toISOString()).toBe("2026-09-30T15:00:00.000Z");
    // 2026-10-02 00:00 JST = 2026-10-01T15:00Z
    expect(jstDayStart(new Date("2026-10-01T15:00:00Z")).toISOString()).toBe("2026-10-01T15:00:00.000Z");
  });

  it("jstDate は JST の日付を返す", () => {
    expect(jstDate(new Date("2026-10-01T15:00:00Z"))).toBe("2026-10-02");
  });
});

describe("isOverBudget", () => {
  it("上限ちょうどまでは許可し、超えたら止める", () => {
    expect(isOverBudget(2.99, 0.01, 3)).toBe(false);
    expect(isOverBudget(2.99, 0.02, 3)).toBe(true);
  });

  it("上限0なら何も呼ばない", () => {
    expect(isOverBudget(0, 0.01, 0)).toBe(true);
  });
});
