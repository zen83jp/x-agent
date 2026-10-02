import { containsUrl } from "../x/pricing";
import { X_MAX_WEIGHTED, findDuplicates, weightedLength } from "./text";

const TRAILING_OFF = /(れば|たら|ので|けど|けれど)[。！!]?$/;
const SUPERLATIVE = /必ず|絶対|No\.?\s?1|ナンバーワン|業界初|最安|日本一|世界一/i;
/** 最上級に近い言い方。意見として使うこともあるので、止めずに要確認として表示する */
const SOFT_SUPERLATIVE = /いちばん|一番|最も/;

export type MechanicalResult = {
  /** 投稿してはいけない問題（URL）。この案は使わない */
  fatal: string[];
  /** 直すべき問題（長さ・最上級表現など）。作り直しの理由になる */
  errors: string[];
  /** 承認者に見せる注意（重複候補など） */
  warnings: string[];
};

/**
 * 投稿案の機械チェック。LLM の審査の前後に必ず通す。
 */
export function mechanicalCheck(body: string, pool: { body: string; label: string }[]): MechanicalResult {
  const fatal: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  if (containsUrl(body)) fatal.push("URL（またはドメイン名）が含まれています");
  const len = weightedLength(body);
  if (len > X_MAX_WEIGHTED) errors.push(`長すぎます（X の文字数 ${len} / ${X_MAX_WEIGHTED}）`);
  if (!body.trim()) errors.push("本文が空です");
  if (/(^|\s)[#＃][^\s#＃]+/.test(body)) errors.push("ハッシュタグが含まれています");
  if (SUPERLATIVE.test(body)) errors.push("断定・最上級の表現が含まれています");
  const trailing = body.split("\n").map((l) => l.trim()).find((l) => TRAILING_OFF.test(l));
  if (trailing) errors.push(`文が言いさしで終わっています: 「${trailing}」`);

  const soft = body.match(SOFT_SUPERLATIVE);
  if (soft) warnings.push(`最上級に近い言い方があります（「${soft[0]}」）。意見として自然か確認してください`);

  const dup = findDuplicates(body, pool)[0];
  if (dup) warnings.push(`${dup.label}と似ています（類似度 ${dup.score.toFixed(2)}）: 「${dup.body.replace(/\s+/g, " ").slice(0, 30)}…」`);

  return { fatal, errors, warnings };
}
