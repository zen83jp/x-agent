import { describe, expect, it } from "vitest";
import { mechanicalCheck } from "@/lib/posts/checks";
import { DEFAULT_SLOTS, nextJstDate, parseSlots } from "@/lib/posts/daily";
import { suggestFabricated } from "@/lib/posts/history";
import { dueCheckpoints } from "@/lib/posts/metrics";
import { buildPostApprovalBlocks, formatJst, nextSlotTime } from "@/lib/posts/slack";
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
  it("21:00 JST の実行は翌日分", () => {
    expect(nextJstDate(new Date("2026-10-02T12:00:00Z"))).toBe("2026-10-03");
  });
});

describe("投稿時刻", () => {
  it("前日21時に承認すれば翌日のその時刻", () => {
    const at = nextSlotTime("07:30", new Date("2026-10-02T12:00:00Z")); // 10/2 21:00 JST
    expect(at.toISOString()).toBe("2026-10-02T22:30:00.000Z"); // 10/3 7:30 JST
    expect(formatJst(at)).toBe("10/3（土）07:30");
  });
  it("当日、その時刻を過ぎてから承認すれば翌日", () => {
    const at = nextSlotTime("07:30", new Date("2026-10-03T00:00:00Z")); // 10/3 9:00 JST
    expect(formatJst(at)).toBe("10/4（日）07:30");
  });
  it("当日、まだ来ていない時刻ならその日", () => {
    expect(formatJst(nextSlotTime("20:30", new Date("2026-10-03T00:00:00Z")))).toBe("10/3（土）20:30");
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
  const view = { draftId: 9, dayLabel: "10/03（土）", reason: "狙い", body: "本文", topic: null, review: null };
  const actions = (kind: "greeting" | "business" | "personal") =>
    (buildPostApprovalBlocks({ ...view, kind }).blocks.find((b) => b.type === "actions") as { elements: { action_id: string }[] }).elements.map(
      (e) => e.action_id,
    );
  it("greeting は 7:30 が先頭", () => {
    expect(actions("greeting")).toEqual(["post_approve_0730", "post_approve_1210", "post_approve_2030", "post_reject"]);
  });
  it("business は 12:10、personal は 20:30 が先頭", () => {
    expect(actions("business")[0]).toBe("post_approve_1210");
    expect(actions("personal")[0]).toBe("post_approve_2030");
  });
  it("処理済み・期限切れならボタンを消す", () => {
    const { blocks } = buildPostApprovalBlocks({ ...view, kind: "greeting", done: "期限切れ" });
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
