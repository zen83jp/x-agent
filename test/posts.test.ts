import { describe, expect, it } from "vitest";
import { mechanicalCheck } from "@/lib/posts/checks";
import { DEFAULT_SLOTS, parseSlots } from "@/lib/posts/daily";
import { targetDatesFrom } from "@/lib/posts/calendar";
import { suggestFabricated } from "@/lib/posts/history";
import { dueCheckpoints } from "@/lib/posts/metrics";
import { approvalDeadline, buildPostApprovalBlocks, formatJst, isPastDeadline, nextSlotTime, slotTimeForIndex } from "@/lib/posts/slack";
import { similarity, weightedLength } from "@/lib/posts/text";
import { isTopicListCommand, parseTopic } from "@/lib/posts/topics";

describe("投稿案の構成", () => {
  it("初期値は greeting＋business＋（personal か business）", () => {
    expect(parseSlots(undefined)).toEqual(DEFAULT_SLOTS);
    expect(DEFAULT_SLOTS).toEqual([["greeting"], ["business"], ["personal", "business"]]);
  });
  it("settings の値を使い、不正なら初期値に戻す", () => {
    expect(parseSlots([["business"], ["greeting"]])).toEqual([["business"], ["greeting"]]);
    expect(parseSlots([["unknown"]])).toEqual(DEFAULT_SLOTS);
    expect(parseSlots("x")).toEqual(DEFAULT_SLOTS);
  });
  it("月〜木は翌日分だけ", () => {
    expect(targetDatesFrom("2026-10-05")).toEqual(["2026-10-06"]); // 月 → 火
    expect(targetDatesFrom("2026-10-08")).toEqual(["2026-10-09"]); // 木 → 金
  });
  it("金曜は土・日・月分", () => {
    expect(targetDatesFrom("2026-10-02")).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
  });
  it("連休前の平日は、連休中と休み明けの平日まで", () => {
    // 10/10（土）〜10/12（月・スポーツの日）の3連休 → 10/13（火）まで
    expect(targetDatesFrom("2026-10-09")).toEqual(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]);
    // 年末年始（12/29〜1/3）→ 1/4（月）まで
    expect(targetDatesFrom("2026-12-28")).toEqual([
      "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04",
    ]);
  });
});

describe("投稿時刻", () => {
  it("前日21時に承認すれば翌日のその時刻", () => {
    const at = nextSlotTime("07:30", new Date("2026-10-02T12:00:00Z")); // 10/2 21:00 JST
    expect(at.toISOString()).toBe("2026-10-02T22:30:00.000Z"); // 10/3 7:30 JST
    expect(formatJst(at)).toBe("10/3（土）7:30");
  });
  it("当日、その時刻を過ぎてから承認すれば翌日", () => {
    const at = nextSlotTime("07:30", new Date("2026-10-03T00:00:00Z")); // 10/3 9:00 JST
    expect(formatJst(at)).toBe("10/4（日）7:30");
  });
  it("当日、まだ来ていない時刻ならその日", () => {
    expect(formatJst(nextSlotTime("20:30", new Date("2026-10-03T00:00:00Z")))).toBe("10/3（土）20:30");
  });
});

describe("承認締切（投稿日の 7:30）", () => {
  it("締切の時刻", () => {
    expect(approvalDeadline("2026-10-04").toISOString()).toBe("2026-10-03T22:30:00.000Z");
    expect(formatJst(approvalDeadline("2026-10-04"))).toBe("10/4（日）7:30");
  });
  it("7:29 は締切前、7:30 からは締切後", () => {
    expect(isPastDeadline("2026-10-04", new Date("2026-10-03T22:29:59Z"))).toBe(false);
    expect(isPastDeadline("2026-10-04", new Date("2026-10-03T22:30:00Z"))).toBe(true);
    // 12:10・20:30 の枠も、7:30 を過ぎたら締切後
    expect(isPastDeadline("2026-10-04", new Date("2026-10-04T02:00:00Z"))).toBe(true);
  });
});

describe("X の文字数", () => {
  it("日本語は2、半角は1、絵文字は2", () => {
    expect(weightedLength("abc")).toBe(3);
    expect(weightedLength("おはよう")).toBe(8);
    expect(weightedLength("おはよう✨")).toBe(10);
    expect(weightedLength("👨‍👩‍👧")).toBe(2);
  });
});

describe("機械チェック", () => {
  const pool = [{ body: "おはようございます！\n今日も前向きな気持ちを忘れずにいきましょう。", label: "過去の投稿" }];
  it("URL は使わない（fatal）", () => {
    expect(mechanicalCheck("詳しくは taskar.online で", []).fatal).toHaveLength(1);
  });
  it("長すぎ・ハッシュタグ・最上級・言いさしは直すべき問題", () => {
    expect(mechanicalCheck("あ".repeat(141), []).errors[0]).toContain("長すぎます");
    expect(mechanicalCheck("今日も頑張ろう #朝活", []).errors).toContain("ハッシュタグが含まれています");
    expect(mechanicalCheck("必ず成果が出ます。", []).errors).toContain("断定・最上級の表現が含まれています");
    expect(mechanicalCheck("一歩ずつ進めれば。", []).errors[0]).toContain("言いさし");
  });
  it("過去の投稿とほぼ同じなら注意に出す", () => {
    const r = mechanicalCheck("おはようございます！\n今日も前向きな気持ちを忘れずにいきましょう✨", pool);
    expect(r.warnings[0]).toContain("過去の投稿と似ています");
    expect(mechanicalCheck("強いチームは、小さな感謝から生まれる。", pool).warnings).toEqual([]);
  });
  it("「いちばん」「一番」「最も」は止めずに要確認として出す", () => {
    const r = mechanicalCheck("小さな約束の積み重ねが、いちばん確かな近道だと思う。", []);
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]).toContain("「いちばん」");
    expect(mechanicalCheck("最も大切なのは、目的を伝えること。", []).warnings[0]).toContain("「最も」");
  });
  it("類似度", () => {
    expect(similarity("今日も一日がんばりましょう", "今日も一日がんばりましょう！")).toBe(1);
    expect(similarity("完璧より継続", "チームは感謝から")).toBeLessThan(0.1);
  });
});

describe("ネタの入力", () => {
  it.each([
    ["ネタ：今日は子どもの運動会で応援してきた", "今日は子どもの運動会で応援してきた"],
    ["ネタ: 新しいスタッフが3人入った", "新しいスタッフが3人入った"],
    ["ネタ：\n1行目\n2行目", "1行目\n2行目"],
  ])("%s", (input, expected) => expect(parseTopic(input)).toBe(expected));
  it("ネタではないもの", () => {
    expect(parseTopic("料金はいくらですか？")).toBeNull();
    expect(parseTopic("ネタ：")).toBeNull();
  });
  it("ネタ一覧", () => {
    expect(isTopicListCommand("ネタ一覧")).toBe(true);
    expect(isTopicListCommand("ネタ一覧を見せて")).toBe(false);
  });
});

describe("【投稿承認】のボタン", () => {
  const view = { draftId: 9, dayLabel: "10/04（日）", targetDate: "2026-10-04", reason: "狙い", body: "本文", topic: null, review: null };
  const actions = (kind: "greeting" | "business" | "personal", slotTime: "07:30" | "12:10" | "20:30" | null) =>
    (buildPostApprovalBlocks({ ...view, kind, slotTime }).blocks.find((b) => b.type === "actions") as { elements: { action_id: string }[] }).elements.map(
      (e) => e.action_id,
    );
  it("枠の既定時刻が先頭（1枠目 7:30／2枠目 12:10／3枠目 20:30）", () => {
    expect(actions("greeting", slotTimeForIndex(0))).toEqual(["post_approve_0730", "post_approve_1210", "post_approve_2030", "post_reject"]);
    expect(actions("business", slotTimeForIndex(1))[0]).toBe("post_approve_1210");
    // personal 枠を business で埋めた3枠目も 20:30 が先頭（2枠目と同じ 12:10 にならない）
    expect(actions("business", slotTimeForIndex(2))).toEqual(["post_approve_2030", "post_approve_0730", "post_approve_1210", "post_reject"]);
    expect(slotTimeForIndex(5)).toBe("20:30");
  });
  it("既定時刻のない古い案は種類で決める", () => {
    expect(actions("greeting", null)[0]).toBe("post_approve_0730");
    expect(actions("personal", null)[0]).toBe("post_approve_2030");
  });
  it("承認締切を表示する", () => {
    expect(JSON.stringify(buildPostApprovalBlocks({ ...view, kind: "greeting", slotTime: "07:30" }).blocks)).toContain("承認締切：10/4（日）7:30");
  });
  it("処理済み・期限切れならボタンを消す", () => {
    const { blocks } = buildPostApprovalBlocks({ ...view, kind: "greeting", slotTime: "07:30", done: "期限切れ" });
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(blocks)).toContain("期限切れ");
  });
});

describe("効果測定のタイミング", () => {
  const posted = new Date("2026-10-01T00:00:00Z");
  it("24h・72h が来たものだけ", () => {
    expect(dueCheckpoints(posted, [], new Date("2026-10-01T23:00:00Z"))).toEqual([]);
    expect(dueCheckpoints(posted, [], new Date("2026-10-02T01:00:00Z"))).toEqual(["24h"]);
    expect(dueCheckpoints(posted, ["24h"], new Date("2026-10-04T01:00:00Z"))).toEqual(["72h"]);
    expect(dueCheckpoints(posted, ["24h", "72h"], new Date("2026-10-05T00:00:00Z"))).toEqual([]);
  });
});

describe("作り話の候補", () => {
  it.each([
    "今朝、Zoom入室ボタン押す前に独り言で気合入れてたら",
    "先月の電気代を見て、思わず声が出ました笑",
    "今日は夕方、思い切ってサウナに行ってきました。",
  ])("候補にする: %s", (t) => expect(suggestFabricated(t)).not.toBeNull());
  it.each([
    "スタッフが来週オンラインで「AI好きの雑談会」を開くそうです。ランチを食べながら",
    "強いチームは、特別なことから生まれるわけじゃない。",
  ])("候補にしない: %s", (t) => expect(suggestFabricated(t)).toBeNull());
});
