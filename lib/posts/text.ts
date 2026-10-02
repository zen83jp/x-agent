/**
 * X の文字数（weighted length）。半角英数・記号などは1、日本語や絵文字は2として数え、上限は280。
 * twitter-text の規則を簡略化したもの（URL は投稿に入れないので扱わない）。
 */
export const X_MAX_WEIGHTED = 280;

const SEGMENTER = new Intl.Segmenter("ja", { granularity: "grapheme" });

function isLight(cp: number): boolean {
  return (
    cp <= 0x10ff ||
    (cp >= 0x2000 && cp <= 0x200d) ||
    (cp >= 0x2010 && cp <= 0x201f) ||
    (cp >= 0x2032 && cp <= 0x2037)
  );
}

export function weightedLength(text: string): number {
  let n = 0;
  for (const { segment } of SEGMENTER.segment(text.normalize("NFC"))) {
    const cps = [...segment].map((c) => c.codePointAt(0)!);
    // 絵文字（異体字セレクタや ZWJ で連結されたものを含む）は1文字として2
    if (/\p{Extended_Pictographic}/u.test(segment)) n += 2;
    else n += cps.reduce((s, cp) => s + (isLight(cp) ? 1 : 2), 0);
  }
  return n;
}

/** 重複判定用に、空白・記号・絵文字を除いた本文 */
export function normalizeForSimilarity(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\p{Extended_Pictographic}]/gu, "");
}

function trigrams(text: string): Set<string> {
  const t = normalizeForSimilarity(text);
  const set = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
  return set;
}

/** 文字の3-gram の Jaccard 係数（0〜1）。言い回しがほぼ同じ投稿の検出用 */
export function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

/** 同じ挨拶の定型句は似て当然なので、これ以上を「ほぼ同じ」とみなす */
export const DUPLICATE_THRESHOLD = 0.45;

export function findDuplicates<T extends { body: string }>(text: string, pool: T[]): (T & { score: number })[] {
  return pool
    .map((p) => ({ ...p, score: similarity(text, p.body) }))
    .filter((p) => p.score >= DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}
