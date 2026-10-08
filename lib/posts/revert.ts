/**
 * 投稿案のスレッドでの「戻す」指示の判定。指示の**全体**が「戻す」だけのときに限る
 * （「原文に近づけて」「元の言い回しを残して」のような部分的な指示は、通常の修正として扱う）。
 *
 * - original: 原文（最初に生成した本文）に戻す …「原文に戻して」「最初の文に戻して」「元の文章に戻して」「元のままで」
 * - previous: 直前の修正版に戻す …「前の案に戻して」「ひとつ前に戻して」「さっきの文に戻して」
 * - ambiguous: どちらか判断できない …「戻して」「元に戻して」
 */
export type RevertKind = "original" | "previous" | "ambiguous";

/** 句読点・空白・記号を除き、文末の依頼の言い回しを外す */
function normalize(text: string): string {
  let t = text.normalize("NFKC").replace(/[\s。、．，,.!！?？「」『』（）()〜~ー-]/g, "");
  const tails = [
    "していただけますか", "してもらえますか", "してくれますか", "してほしいです", "してほしい", "して欲しい",
    "してください", "して下さい", "してくださいませ", "してお願いします", "お願いいたします", "お願いします", "お願い",
    "ください", "下さい", "でお願いします", "でいいです", "でいい", "でよいです", "でよい", "で大丈夫です", "で大丈夫",
  ];
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of tails) {
      if (t.endsWith(s) && t.length > s.length) {
        t = t.slice(0, -s.length);
        changed = true;
      }
    }
  }
  return t;
}

const BACK = "(?:に|へ)?(?:戻|もど)(?:して|す|る)?";
const THING = "(?:文章|文|案|本文|版|もの|状態|バージョン|ver|やつ)";

const PREVIOUS = new RegExp(
  `^(?:(?:1|一|ひと)つ前|ひとつまえ|前|直前|さっき|先ほど|先程)(?:の${THING}?)?${BACK}$`,
);
const ORIGINAL = new RegExp(
  `^(?:原文|オリジナル|最初|初め|はじめ|元|もと)(?:の${THING})?${BACK}$|^(?:原文|最初|初め|はじめ)${BACK}$`,
);
const ORIGINAL_AS_IS = /^(?:原文|最初|元|もと)(?:の(?:文章|文|案|本文))?のまま(?:で|にして|に)?$/;
const AMBIGUOUS = new RegExp(`^(?:元|もと)?${BACK}$`);

export function classifyRevert(instruction: string): RevertKind | null {
  const t = normalize(instruction);
  if (!t) return null;
  if (PREVIOUS.test(t)) return "previous";
  // 「元に戻して」は「元（=原文）」とも「1つ前」とも取れるので、どちらか判断できないとする
  if (AMBIGUOUS.test(t)) return "ambiguous";
  if (ORIGINAL.test(t) || ORIGINAL_AS_IS.test(t)) return "original";
  return null;
}

export const AMBIGUOUS_REVERT_GUIDE =
  "原文に戻す場合は『原文に戻して』、1つ前に戻す場合は『1つ前に戻して』と返信してください。";
