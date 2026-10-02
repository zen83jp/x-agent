/**
 * DM 返信の「差し戻し」ルール。ここに引っかかる文面は送信しない（返信案の生成時は1回作り直し、
 * それでも残れば「要修正」として［送信］ボタンを出さない。送信処理でも同じチェックで拒否する）。
 *
 * 景表法・料金表示のルール（CLAUDE.md のセルフレビュー、prompts/dm_reply.md の絶対ルール）を機械的に守らせる。
 */

/** 「割引」を打ち消す決まった形だけは許可する（割引の有無を聞かれたときの正しい答え） */
const DISCOUNT_NEGATIONS = [
  "割引は行っていません",
  "割引は行っておりません",
  "割引はございません",
  "割引はありません",
  "割引制度はありません",
  "割引制度はございません",
];

/** 割引制度がないため、プラン間の比較でも使わない言葉 */
const DISCOUNT_NG = /お得|おトク|お値打ち|割引|割安|値引|半額|[0-9０-９.．]+\s*[%％]\s*(?:オフ|off|引)/i;

/** 「円」を含む数値（25,000円、２５，０００円、2万5千円、2.5万円、二万五千円 など） */
const PRICE = /(?:[0-9０-９][0-9０-９,，.．]*|[一二三四五六七八九十百千〇]+)(?:[万千][0-9０-９一二三四五六七八九十百千〇,，.．]*)*円/g;

const SENTENCE_END = /[。！？!?\n]/;
const MID_CANCEL = /途中解約(?:不可|はでき(?:ず|ません)|できません)/;
const AUTO_RENEW = /自動更新/;
const USUAL_FIVE_DAYS = /通常(?:は)?\s*[5５]\s*営業日/;
/** 時間単価の表現（金額と一緒に出てきたときだけ見る） */
const HOURLY = /[1１一]\s*時間(?:あたり|当たり|につき)|時間単価|時給/;
/** 「月10時間から（10時間単位）」の契約であることの表記 */
const TEN_HOURS = /(?:10|１０|十)\s*時間/;
const URL_IN_TEXT = /https?:\/\/[^\s<>「」（）()]+/g;

/** text の index を含む1文（「。」「！」「？」や改行で区切る。括弧の中も含む） */
function sentenceAt(text: string, index: number): string {
  let start = index;
  while (start > 0 && !SENTENCE_END.test(text[start - 1]!)) start--;
  let end = index;
  while (end < text.length && !SENTENCE_END.test(text[end]!)) end++;
  return text.slice(start, end);
}

export function findPrices(text: string): { value: string; index: number }[] {
  return [...text.matchAll(PRICE)].map((m) => ({ value: m[0], index: m.index ?? 0 }));
}

/**
 * 差し戻しの理由（空なら問題なし）。
 * allowed は送ってよい URL（日程調整 URL と FAQ に載っている URL）。
 */
export function blockingIssues(text: string | null, allowed: string[]): string[] {
  if (!text) return [];
  const issues: string[] = [];

  const withoutNegations = DISCOUNT_NEGATIONS.reduce((t, n) => t.split(n).join(""), text);
  const discount = withoutNegations.match(DISCOUNT_NG);
  if (discount) issues.push(`割引を連想させる表現は使えません（「${discount[0]}」。割引制度はありません）`);

  if (text.includes("税込")) issues.push("「税込」は使えません（税込価格は公開していません）");

  const prices = findPrices(text);
  for (const p of prices) {
    if (!sentenceAt(text, p.index).includes("税抜")) issues.push(`金額（${p.value}）と同じ文に「税抜」がありません`);
  }
  if (prices.length) {
    if (!MID_CANCEL.test(text)) issues.push("料金に触れているのに「途中解約不可」がありません");
    if (!AUTO_RENEW.test(text)) issues.push("料金に触れているのに「自動更新」がありません");
    // 1時間単位で契約できると読めないように、時間単価には「月10時間から（10時間単位）」を添える
    const hourly = text.match(HOURLY);
    if (hourly && !TEN_HOURS.test(text)) {
      issues.push(`時間単価（「${hourly[0]}」）を書くときは「月10時間から（10時間単位）のご契約」であることを添えてください`);
    }
  }

  if (text.includes("最短翌営業日") && !USUAL_FIVE_DAYS.test(text)) {
    issues.push("「最短翌営業日」だけで、「通常5営業日ほど」がありません");
  }

  for (const url of text.match(URL_IN_TEXT) ?? []) {
    if (!allowed.some((a) => url.startsWith(a))) issues.push(`許可されていない URL が含まれています: ${url}`);
  }
  return issues;
}

/** needs_human_check の中で、送信を止める項目の印 */
export const BLOCK_PREFIX = "要修正: ";

export function isBlocked(checks: string[] | null | undefined): boolean {
  return (checks ?? []).some((c) => c.startsWith(BLOCK_PREFIX));
}
