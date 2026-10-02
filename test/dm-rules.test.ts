import { describe, expect, it } from "vitest";
import { blockingIssues, findPrices, isBlocked } from "@/lib/dm/rules";

const MEETING = "https://app.spirinc.com/t/abc";
const allowed = [MEETING, "https://taskar.online/staff/"];
const OK_PRICE =
  "料金は月10時間あたり、12ヶ月25,000円／6ヶ月30,000円／3ヶ月40,000円です（税抜・途中解約不可・期間ごとの自動更新）。";

describe("割引を連想させる表現", () => {
  it("決まった打ち消しの形だけは通す", () => {
    expect(blockingIssues("割引は行っていません。契約期間が長いプランほど月額が下がる料金体系です。", allowed)).toEqual([]);
    expect(blockingIssues("割引制度はありません。", allowed)).toEqual([]);
    expect(blockingIssues("割引はございません。", allowed)).toEqual([]);
  });

  it("「割引はありませんが、12ヶ月プランがお得です」は「お得」で差し戻す", () => {
    const issues = blockingIssues("割引はありませんが、12ヶ月プランがお得です。", allowed);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("「お得」");
  });

  it.each(["12ヶ月プランなら割安です。", "長期契約で20%オフになります。", "長期契約で２０％OFFです。", "お値引きも可能です。", "おトクなプランです。"])(
    "差し戻す: %s",
    (t) => expect(blockingIssues(t, allowed).join()).toContain("割引を連想させる表現"),
  );

  it("打ち消しの形でも「割引」以外の語は例外にならない", () => {
    expect(blockingIssues("割引は行っていませんが、割安です。", allowed).join()).toContain("「割安」");
  });
});

describe("金額と税抜", () => {
  it("FAQ どおりの書き方は通る", () => {
    expect(blockingIssues(OK_PRICE, allowed)).toEqual([]);
  });

  it("円を含む数値として、漢数字・万・全角も見つける", () => {
    expect(findPrices("2万5千円、2.5万円、二万五千円、２５，０００円、25,000円").map((p) => p.value)).toEqual([
      "2万5千円",
      "2.5万円",
      "二万五千円",
      "２５，０００円",
      "25,000円",
    ]);
    expect(findPrices("円滑に進めます。").length).toBe(0);
  });

  it("同じ文に税抜がない金額は差し戻す（計算した時間単価も）", () => {
    const t = `${OK_PRICE}\n1時間あたりにすると2,500円です。`;
    expect(blockingIssues(t, allowed)).toEqual(["金額（2,500円）と同じ文に「税抜」がありません"]);
    expect(blockingIssues(`${OK_PRICE}\n1時間あたり2,500円（税抜）です。`, allowed)).toEqual([]);
  });

  it("2万5千円・全角でも税抜を確認する", () => {
    expect(blockingIssues("月2万5千円です（途中解約不可・自動更新）。", allowed).join()).toContain("2万5千円");
    expect(blockingIssues("月２５，０００円です（途中解約不可・自動更新）。", allowed).join()).toContain("２５，０００円");
  });

  it("「税込」は差し戻す", () => {
    expect(blockingIssues(`${OK_PRICE}税込では27,500円です（税抜25,000円）。`, allowed).join()).toContain("「税込」は使えません");
  });

  it("料金に触れて「途中解約不可」「自動更新」がなければ差し戻す", () => {
    const issues = blockingIssues("月10時間で25,000円（税抜）です。", allowed);
    expect(issues).toContain("料金に触れているのに「途中解約不可」がありません");
    expect(issues).toContain("料金に触れているのに「自動更新」がありません");
    expect(blockingIssues("月10時間で25,000円（税抜）です。途中解約はできず、プラン期間で自動更新となります。", allowed)).toEqual([]);
  });
});

describe("開始時期と URL", () => {
  it("「最短翌営業日」だけなら差し戻す", () => {
    expect(blockingIssues("最短翌営業日から開始できます。", allowed)).toEqual(["「最短翌営業日」だけで、「通常5営業日ほど」がありません"]);
    expect(blockingIssues("最短翌営業日ですが、通常は5営業日ほどで開始しています。", allowed)).toEqual([]);
  });

  it("許可外の URL は差し戻す（日程調整と FAQ の URL は通す）", () => {
    expect(blockingIssues(`▼日程調整サイトからご予約をお願いいたします。\n${MEETING}`, allowed)).toEqual([]);
    expect(blockingIssues("https://example.com をご覧ください。", allowed).join()).toContain("example.com");
  });
});

describe("要修正の印", () => {
  it("needs_human_check に「要修正: 」があれば送信を止める", () => {
    expect(isBlocked(["要修正: 金額（2,500円）と同じ文に「税抜」がありません"])).toBe(true);
    expect(isBlocked(["相手が名乗っていないため名前なし"])).toBe(false);
    expect(isBlocked(null)).toBe(false);
  });
});

describe("時間単価と10時間単位", () => {
  const tail = "（いずれも税抜・途中解約不可・期間ごとの自動更新）です。";
  it("時間単価だけで「10時間」がなければ差し戻す（確認用の返信案の実例）", () => {
    const t = `1時間あたりは、12ヶ月プラン2,500円／6ヶ月プラン3,000円／3ヶ月プラン4,000円${tail}`;
    expect(blockingIssues(t, allowed)).toEqual([
      "時間単価（「1時間あたり」）を書くときは「月10時間から（10時間単位）のご契約」であることを添えてください",
    ]);
  });
  it("「月10時間から（10時間単位）」があれば通す", () => {
    const t = `ご契約は月10時間から（10時間単位）です。1時間あたりにすると、12ヶ月プランで2,500円${tail}`;
    expect(blockingIssues(t, allowed)).toEqual([]);
  });
  it("時間単価・時給の言い方も対象", () => {
    expect(blockingIssues(`時給換算で2,500円${tail}`, allowed).join()).toContain("「時給」");
    expect(blockingIssues(`時間単価は2,500円${tail}`, allowed).join()).toContain("「時間単価」");
  });
  it("金額のない「1時間あたり」は対象外", () => {
    expect(blockingIssues("1時間あたりの作業量は業務によって変わります。", allowed)).toEqual([]);
  });
});
