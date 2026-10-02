import { describe, expect, it } from "vitest";
import { buildSummary, contextFromScreenshot, imageFiles, pickReplyText, stripMentions } from "@/lib/dm/assist";
import { allowedUrls, checkReplyText, checkShortened, countBodyChars } from "@/lib/dm/generate";
import { normalizeUsername } from "@/lib/dm/leads";
import { isNewer, newestId, selectNewEvents, shouldReadNextPage } from "@/lib/dm/poll";
import type { Classification, Reply } from "@/lib/dm/schemas";
import { approvalModeFor, buildApprovalBlocks } from "@/lib/dm/slack";
import { isTargetEvent } from "@/lib/slack/events";
import { counterpartId } from "@/lib/x/dm";

const ev = (id: string) => ({ id, event_type: "MessageCreate" });

describe("ポーリングのカーソル判定", () => {
  it("桁数が違う ID も数値として比べる", () => {
    expect(isNewer("1000000000000000000", "999999999999999999")).toBe(true);
    expect(isNewer("999999999999999999", "1000000000000000000")).toBe(false);
    expect(isNewer("5", "5")).toBe(false);
  });

  it("カーソルより新しいものだけを古い順に返す", () => {
    expect(selectNewEvents([ev("30"), ev("10"), ev("25"), ev("20")], "20").map((e) => e.id)).toEqual(["25", "30"]);
  });

  it("ページが全部新しく、次のページがあるときだけ次を読む", () => {
    expect(shouldReadNextPage([ev("30"), ev("25")], "20", "tok")).toBe(true);
    expect(shouldReadNextPage([ev("30"), ev("20")], "20", "tok")).toBe(false);
    expect(shouldReadNextPage([ev("30")], "20", undefined)).toBe(false);
    expect(shouldReadNextPage([], "20", "tok")).toBe(false);
  });

  it("初回用に最新 ID を返す", () => {
    expect(newestId([ev("9"), ev("100"), ev("20")])).toBe("100");
    expect(newestId([])).toBeNull();
  });
});

describe("counterpartId", () => {
  it("1対1の会話 ID から相手を取り出す", () => {
    expect(counterpartId("111-129194409", "129194409")).toBe("111");
    expect(counterpartId("129194409-999", "129194409")).toBe("999");
  });
  it("グループ会話・自分を含まない ID は null", () => {
    expect(counterpartId("1582665211437195264", "129194409")).toBeNull();
    expect(counterpartId("1-2", "129194409")).toBeNull();
  });
});

const cls = (category: Classification["category"], extra: Partial<Classification> = {}): Classification => ({
  category,
  confidence: 0.9,
  reason: "理由",
  company: null,
  need: null,
  urgency: "normal",
  meeting_intent: false,
  flags: [],
  ...extra,
});

describe("カテゴリ → 承認メッセージの種類", () => {
  it.each([
    ["spam", true, null],
    ["greeting", false, null],
    ["greeting", true, "normal"],
    ["sales_pitch", false, "decline"],
    ["invitation", false, "decline"],
    ["escalate", false, "manual"],
    ["faq", false, "manual"],
    ["faq", true, "normal"],
    ["inquiry_detailed", true, "normal"],
  ] as const)("%s（返信案あり=%s）→ %s", (c, hasReply, mode) => expect(approvalModeFor(c, hasReply)).toBe(mode));

  it("分類に失敗したら manual", () => expect(approvalModeFor(null, false)).toBe("manual"));
});

describe("buildApprovalBlocks", () => {
  const base = {
    messageId: 42,
    sender: { name: "山田", username: "yamada" },
    body: "料金は？ <script>",
    classification: cls("faq"),
    draft: "返信案です",
    declineReply: "お断りです",
    checks: [],
  };
  const buttons = (blocks: ReturnType<typeof buildApprovalBlocks>["blocks"]) =>
    blocks.flatMap((b) => (b.type === "actions" ? b.elements.map((e) => (e as { action_id: string }).action_id) : []));

  it("通常は4つのボタンで、value に dm_messages.id を入れる", () => {
    const { blocks } = buildApprovalBlocks({ ...base, mode: "normal" });
    expect(buttons(blocks)).toEqual(["dm_send", "dm_edit", "dm_skip", "dm_lead_only"]);
    const actions = blocks.find((b) => b.type === "actions") as { elements: { value: string }[] };
    expect(actions.elements.every((e) => e.value === "42")).toBe(true);
  });

  it("営業・招待は [丁寧に断る][無視] で、お断り文を表示する", () => {
    const { blocks } = buildApprovalBlocks({ ...base, classification: cls("sales_pitch"), mode: "decline" });
    expect(buttons(blocks)).toEqual(["dm_decline", "dm_skip"]);
    expect(JSON.stringify(blocks)).toContain("お断りです");
    expect(JSON.stringify(blocks)).not.toContain("返信案です");
  });

  it("要修正が残っていたら［送信］を出さず、［修正して送信］を先頭にする", () => {
    const blocked = buildApprovalBlocks({ ...base, mode: "normal", blocked: true, checks: ["要修正: 金額（2,500円）と同じ文に「税抜」がありません"] });
    expect(buttons(blocked.blocks)).toEqual(["dm_edit", "dm_skip", "dm_lead_only"]);
    expect(JSON.stringify(blocked.blocks)).toContain("要修正（このままでは送信できません）");
    const decline = buildApprovalBlocks({ ...base, classification: cls("sales_pitch"), mode: "decline", blocked: true });
    expect(buttons(decline.blocks)).toEqual(["dm_edit", "dm_skip"]);
  });

  it("escalate は [自分で書いて送信][送らない]", () => {
    expect(buttons(buildApprovalBlocks({ ...base, mode: "manual", draft: null }).blocks)).toEqual(["dm_edit", "dm_skip"]);
  });

  it("処理済みならボタンの代わりに結果を表示する", () => {
    const { blocks } = buildApprovalBlocks({ ...base, mode: "normal", done: "送信しました" });
    expect(buttons(blocks)).toEqual([]);
    expect(JSON.stringify(blocks)).toContain("送信しました");
  });

  it("DM 本文の < > & をエスケープする", () => {
    expect(JSON.stringify(buildApprovalBlocks({ ...base, mode: "normal" }).blocks)).toContain("&lt;script&gt;");
  });
});

describe("返信案の機械チェック", () => {
  const meeting = "https://app.spirinc.com/t/abc";
  const allowed = allowedUrls(meeting, [{ answer: "応募は https://taskar.online/staff/ から" }]);
  const good = [
    "山田さん、ご質問ありがとうございます！",
    "料金は月10時間で25,000円（税抜・12ヶ月プラン）です。途中解約はできず、プラン期間で自動更新となります。",
    "詳しくは15分ほどお話しできればと思います。",
    "▼日程調整サイトからご予約をお願いいたします。",
    meeting,
  ].join("\n");

  it("お礼／本題／誘い／定型文／URL の形なら問題なし", () => {
    expect(checkReplyText(good, allowed, meeting)).toEqual([]);
  });

  it("字数は定型文と URL の行、改行を除いた本文だけで数える", () => {
    expect(countBodyChars(good, meeting)).toBe([..."山田さん、ご質問ありがとうございます！料金は月10時間で25,000円（税抜・12ヶ月プラン）です。途中解約はできず、プラン期間で自動更新となります。詳しくは15分ほどお話しできればと思います。"].length);
    // 本文199字＋定型文・URL は 200字以内として通る
    const body = "あ".repeat(199) + "。";
    expect(checkReplyText([body, "▼日程調整サイトからご予約をお願いいたします。", meeting].join("\n"), allowed, meeting)).toEqual([]);
    expect(checkReplyText("あ".repeat(201), allowed, meeting).join()).toContain("200字を超えています（201字");
  });

  it("URL の許可・不許可は差し戻しのルール（rules.ts）で見るので、体裁のチェックには出さない", () => {
    expect(checkReplyText("応募はこちらからお願いします。\nhttps://taskar.online/staff/", allowed, meeting)).toEqual([]);
  });

  it("定型文や URL が本文と同じ行にあれば要確認にする", () => {
    const issues = checkReplyText(`ぜひお話しできればと思います。▼日程調整サイトからご予約をお願いいたします。${meeting}`, allowed, meeting);
    expect(issues.join()).toContain("日程調整 URL が独立した行になっていません");
    expect(issues.join()).toContain("定型文が独立した行になっていません");
  });

  it("言いさしで終わる文を要確認にする", () => {
    const issues = checkReplyText(["詳しくは15分ほどお話しできれば。", "▼日程調整サイトからご予約をお願いいたします。", meeting].join("\n"), allowed, meeting);
    expect(issues).toEqual(["文が言いさしで終わっています: 「詳しくは15分ほどお話しできれば。」"]);
  });

  it("お礼と本題が1行につながっていたら「改行が足りない」を要確認にする（修正前の実例）", () => {
    const joined = [
      "ありがとうございます！月10時間あたり、12ヶ月25,000円（税抜）です。途中解約不可、プラン期間で自動更新です。詳しくは15分ほどお話しできればと思います。",
      "▼日程調整サイトからご予約をお願いいたします。",
      meeting,
    ].join("\n");
    expect(checkReplyText(joined, allowed, meeting)).toEqual([
      "改行が足りません（お礼／本題／面談の誘いをそれぞれ別の行にしてください）",
    ]);
  });

  it("文が少ない短い返信なら1〜2行でもよい", () => {
    expect(checkReplyText("ご連絡ありがとうございます！", allowed, meeting)).toEqual([]);
    expect(checkReplyText("ご連絡ありがとうございます。\n今回は見送らせていただきます。", allowed, meeting)).toEqual([]);
  });

  it("null なら何もしない", () => expect(checkReplyText(null, allowed, meeting)).toEqual([]));
});

describe("作り直しの短縮チェック", () => {
  const meeting = "https://app.spirinc.com/t/abc";
  const tail = ["▼日程調整サイトからご予約をお願いいたします。", meeting];
  const before = ["ご連絡ありがとうございます！", "料金は（いずれも税抜）です。途中解約はできず、各プランの期間で自動更新となります。", ...tail].join("\n");
  const shorter = ["ご連絡ありがとうございます！", "料金は（税抜・途中解約不可・期間ごとの自動更新）です。", ...tail].join("\n");

  it("「もっと短く」で本文が短くなっていれば問題なし（定型文と URL は数えない）", () => {
    expect(checkShortened({ previousReply: before, instructions: ["もっと短く"] }, shorter, meeting)).toEqual([]);
  });

  it("「もっと短く」で短くなっていなければ要確認にする", () => {
    const issues = checkShortened({ previousReply: shorter, instructions: ["もっと短く"] }, before, meeting);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("短くなっていません");
  });

  it("同じ長さも要確認にする", () => {
    expect(checkShortened({ previousReply: before, instructions: ["簡潔に"] }, before, meeting)).toHaveLength(1);
  });

  it("最新の指示が短縮でなければチェックしない", () => {
    expect(checkShortened({ previousReply: shorter, instructions: ["もっと短く", "料金には触れないで"] }, before, meeting)).toEqual([]);
  });
});

describe("normalizeUsername（名寄せキー）", () => {
  it("@ を外して小文字にする", () => expect(normalizeUsername("@Zen_Kaku")).toBe("zen_kaku"));
  it.each([null, "", "名前", "too_long_username_x", "a b"])("不正なら null: %s", (u) => expect(normalizeUsername(u)).toBeNull());
});

describe("返信アシスタント", () => {
  it("メンションを取り除く", () => {
    expect(stripMentions("<@U0ABC123> 料金はいくらですか？")).toBe("料金はいくらですか？");
    expect(stripMentions("<@U0ABC123|x-agent>  もっと短く ")).toBe("もっと短く");
    expect(stripMentions(undefined)).toBe("");
  });

  it("画像ファイルだけを対象にする", () => {
    const files = imageFiles([
      { mimetype: "image/png", url_private_download: "https://files.slack.com/a.png" },
      { mimetype: "application/pdf", url_private_download: "https://files.slack.com/a.pdf" },
      { mimetype: "image/jpeg" },
    ]);
    expect(files).toHaveLength(1);
  });

  describe("スクショ → 入力", () => {
    const shot = (messages: { from: "them" | "me"; text: string }[]) => ({
      readable: true,
      counterpart_name: "山田太郎",
      counterpart_username: "@Yamada_Taro",
      messages,
    });

    it("末尾に続く相手の発言をまとめて新着にし、前を履歴にする", () => {
      const ctx = contextFromScreenshot(
        shot([
          { from: "me", text: "フォローありがとうございます" },
          { from: "them", text: "こちらこそ" },
          { from: "me", text: "よろしくお願いします" },
          { from: "them", text: "実は経理を" },
          { from: "them", text: "お願いしたくて" },
        ]),
        "補足メモ",
      )!;
      expect(ctx.newMessage).toBe("実は経理を\nお願いしたくて");
      expect(ctx.history).toHaveLength(3);
      expect(ctx.sender).toEqual({ name: "山田太郎", username: "yamada_taro" });
      expect(ctx.note).toBe("補足メモ");
    });

    it("最後が自分の発言なら、最後の相手の発言を新着にする", () => {
      const ctx = contextFromScreenshot(
        shot([
          { from: "them", text: "料金は？" },
          { from: "me", text: "書きかけ" },
        ]),
        null,
      )!;
      expect(ctx.newMessage).toBe("料金は？");
      expect(ctx.history).toEqual([]);
    });

    it("相手の発言がなければ null", () => {
      expect(contextFromScreenshot(shot([{ from: "me", text: "こんにちは" }]), null)).toBeNull();
    });
  });

  const reply = (r: Partial<Reply>): Reply => ({
    reply: null,
    uses_faq_ids: [],
    needs_human_check: [],
    suggested_lead_note: null,
    decline_reply: null,
    ...r,
  });

  it("営業・招待はお断り文、それ以外は返信案を表示する", () => {
    expect(pickReplyText(cls("sales_pitch"), reply({ reply: null, decline_reply: "お断り" }))).toBe("お断り");
    expect(pickReplyText(cls("faq"), reply({ reply: "回答", decline_reply: null }))).toBe("回答");
    expect(pickReplyText(cls("faq"), null)).toBeNull();
  });

  it("要約に相手・分類・リード登録・要確認を出す", () => {
    const text = buildSummary({
      ctx: { history: [], newMessage: "x", sender: { name: "山田", username: "yamada" } },
      classification: cls("inquiry_detailed", { reason: "具体的な相談" }),
      replyText: "返信",
      checks: ["料金の確認"],
      lead: "created_or_updated",
    });
    expect(text).toContain("山田 @yamada");
    expect(text).toContain("inquiry_detailed");
    expect(text).toContain("リード");
    expect(text).toContain("料金の確認");
    expect(text).toContain("返信案（コピーして X アプリから送信）");
  });

  it("escalate は返信案なしで自分で対応するよう案内する", () => {
    const text = buildSummary({
      ctx: { history: [], newMessage: "x", sender: {} },
      classification: cls("escalate"),
      replyText: null,
      checks: [],
      lead: "none",
    });
    expect(text).toContain("（読み取れず）");
    expect(text).toContain("ご自身で対応");
  });
});

describe("isTargetEvent", () => {
  const ch = "C0BFNHP57JQ";
  it.each([
    [{ type: "app_mention", channel: ch }, true],
    [{ type: "message", channel: ch }, true],
    [{ type: "message", channel: ch, subtype: "file_share" }, true],
    [{ type: "message", channel: "C_OTHER" }, false],
    [{ type: "message", channel: ch, bot_id: "B1" }, false],
    [{ type: "message", channel: ch, subtype: "message_changed" }, false],
    [{ type: "reaction_added", channel: ch }, false],
  ])("%o → %s", (e, expected) => expect(isTargetEvent(e, ch)).toBe(expected));
});
