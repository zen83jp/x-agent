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

/** 挨拶の定型として、重なっても問題にしない言い回し（正規化後） */
const COMMON_PHRASES = ["おはようございます", "今日も", "最高の1日にしましょう", "最高の一日にしましょう"];

/**
 * 2つの本文に共通する最長の言い回し（空白・記号を除いて比べる。定型の挨拶は除く）。
 * 連続する日の投稿で、同じ特徴的なフレーズを使っていないかの検出用
 */
export function longestSharedPhrase(a: string, b: string): string {
  const strip = (t: string) => COMMON_PHRASES.reduce((s, p) => s.split(p).join("|"), normalizeForSimilarity(t));
  const x = strip(a);
  const y = strip(b);
  let best = "";
  const prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let diag = 0;
    for (let j = 1; j <= y.length; j++) {
      const up = prev[j]!;
      prev[j] = x[i - 1] === y[j - 1] && x[i - 1] !== "|" ? diag + 1 : 0;
      if (prev[j]! > best.length) best = x.slice(i - prev[j]!, i);
      diag = up;
    }
  }
  return best;
}

/** これ以上の長さの共通フレーズを「同じ言い回し」とみなす（例：「お休みの方もお仕事の方も」は12） */
export const SHARED_PHRASE_MIN = 8;
