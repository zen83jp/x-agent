import { describe, expect, it } from "vitest";
import { dayContext, describeDay, jstDateOf } from "@/lib/posts/calendar";

describe("暦情報", () => {
  it("祝日と曜日", () => {
    const c = dayContext("2026-10-12");
    expect(c.weekday).toBe("月");
    expect(c.holiday).toBe("スポーツの日");
    expect(c.dayOff).toBe(true);
  });

  it("3連休明け（10/10土〜10/12月）の火曜日", () => {
    const c = dayContext("2026-10-13");
    expect(c.afterLongBreak).toBe(true);
    expect(describeDay(c)).toBe("10/13（火） / 連休明け");
  });

  it("シルバーウィーク（9/19〜9/23）明けの木曜日", () => {
    expect(dayContext("2026-09-24").afterLongBreak).toBe(true);
  });

  it("普通の月曜日は週明け（連休明けではない）", () => {
    const c = dayContext("2026-10-05");
    expect(c.afterLongBreak).toBe(false);
    expect(c.firstWorkdayAfterBreak).toBe(true);
    expect(describeDay(c)).toBe("10/05（月） / 週明け・休み明け");
  });

  it("月末・月初と、休み前の最終日", () => {
    expect(dayContext("2026-10-30").beforeBreak).toBe(true); // 金曜
    expect(dayContext("2026-10-31").monthEnd).toBe(true);
    expect(dayContext("2026-11-01").monthStart).toBe(true);
    expect(dayContext("2026-02-28").monthEnd).toBe(true);
  });

  it("年末年始は休みとして扱う", () => {
    expect(dayContext("2026-12-30").holiday).toBe("年末年始");
    expect(dayContext("2027-01-04").afterLongBreak).toBe(true);
  });

  it("祝日表のない年は気づけるようにする", () => {
    expect(dayContext("2028-05-01").holidayDataMissing).toBe(true);
    expect(dayContext("2026-05-01").holidayDataMissing).toBe(false);
  });

  it("JST の日付", () => {
    expect(jstDateOf(new Date("2026-10-01T15:00:00Z"))).toBe("2026-10-02");
  });
});
