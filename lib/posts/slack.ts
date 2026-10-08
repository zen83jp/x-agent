import type { KnownBlock } from "@slack/web-api";
import { esc } from "../dm/slack";
import type { PostKind, ReviewNote } from "./schemas";

/** 投稿時刻の候補（JST） */
export const SLOTS = ["07:30", "12:10", "20:30"] as const;
export type Slot = (typeof SLOTS)[number];

/** 枠の順番（0始まり）→ 既定の投稿時刻。1枠目 7:30／2枠目 12:10／3枠目以降 20:30 */
export function slotTimeForIndex(i: number): Slot {
  return SLOTS[Math.min(i, SLOTS.length - 1)]!;
}

/** 承認ボタンの並び。枠の既定時刻を先頭にし、残りは時刻順（同じ時刻に2本並ばないように） */
export function slotOrder(defaultSlot: Slot): Slot[] {
  return [defaultSlot, ...SLOTS.filter((s) => s !== defaultSlot)];
}

/** 既定時刻がない古い投稿案のための、種類ごとの既定値 */
const KIND_DEFAULT_SLOT: Record<PostKind, Slot> = { greeting: "07:30", business: "12:10", personal: "20:30" };

const KIND_LABEL: Record<PostKind, string> = {
  greeting: "朝の挨拶（greeting）",
  business: "学び・経営（business）",
  personal: "日常（personal）",
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 指定した日（JST の YYYY-MM-DD）のその時刻 */
export function slotTimeOn(date: string, slot: Slot): Date {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, m] = slot.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, m) - JST_OFFSET_MS);
}

/** 承認の締切: 投稿日の 7:30 JST。これを過ぎたら、その日の未承認の案はすべて期限切れ */
export const APPROVAL_DEADLINE: Slot = "07:30";

export function approvalDeadline(targetDate: string): Date {
  return slotTimeOn(targetDate, APPROVAL_DEADLINE);
}

export function isPastDeadline(targetDate: string, now: Date): boolean {
  return now.getTime() >= approvalDeadline(targetDate).getTime();
}

/** その時刻（JST）の次の発生時刻。今より後で最も近いもの（target_date がない古い案だけで使う） */
export function nextSlotTime(slot: Slot, now: Date): Date {
  const [h, m] = slot.split(":").map(Number) as [number, number];
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const candidate = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), h, m) - JST_OFFSET_MS);
  if (candidate.getTime() <= now.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return candidate;
}

export function formatJst(d: Date): string {
  const jst = new Date(d.getTime() + JST_OFFSET_MS);
  const wd = ["日", "月", "火", "水", "木", "金", "土"][jst.getUTCDay()];
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}（${wd}）${jst.getUTCHours()}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
}

/** 要確認の項目（審査で直した点と、機械チェックの注意）。スレッドに詳細として出す */
export function reviewNotes(review: ReviewNote | null | undefined): string[] {
  return [
    ...(review?.issues ?? []).map((i) => `審査で直した点（${i.type}）: ${i.detail}`),
    ...(review?.warnings ?? []),
  ];
}

export type PostApprovalView = {
  draftId: number;
  kind: PostKind;
  /** 枠の既定時刻（承認ボタンの先頭） */
  slotTime: Slot | null;
  /** 投稿日（承認締切の表示に使う） */
  targetDate: string | null;
  dayLabel: string;
  reason: string | null;
  body: string;
  topic: string | null;
  review: ReviewNote | null;
  /** 処理済みならボタンの代わりに表示する一文 */
  done?: string | null;
};

/** 【投稿承認】メッセージの本体（ラベルは postMessage が付ける） */
export function buildPostApprovalBlocks(v: PostApprovalView): { text: string; blocks: KnownBlock[] } {
  const quote = (t: string) =>
    esc(t)
      .split("\n")
      .map((l) => `>${l}`)
      .join("\n");
  const blocks: KnownBlock[] = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${KIND_LABEL[v.kind]}* ｜ ${esc(v.dayLabel)} 向け${v.targetDate ? ` ｜ 承認締切：${formatJst(approvalDeadline(v.targetDate))}` : ""}`,
        },
      ],
    },
  ];
  if (v.reason) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `狙い: ${esc(v.reason)}` }] });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: quote(v.body) } });
  if (v.topic) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `元のネタ: ${esc(v.topic)}` }] });
  }
  // 要確認の詳細はスレッドに出し、1スレッド目には有無だけを短く表示する（承認する人が見落とさないように）
  if (reviewNotes(v.review).length) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: ":warning: *要確認あり（スレッド参照）*" }] });
  }
  if (v.done) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: v.done }] });
  } else {
    blocks.push({
      type: "actions",
      elements: [
        ...slotOrder(v.slotTime ?? KIND_DEFAULT_SLOT[v.kind]).map((slot, i) => ({
          type: "button" as const,
          action_id: `post_approve_${slot.replace(":", "")}`,
          value: String(v.draftId),
          text: { type: "plain_text" as const, text: `${slot}に承認` },
          ...(i === 0 ? { style: "primary" as const } : {}),
        })),
        {
          type: "button" as const,
          action_id: "post_reject",
          value: String(v.draftId),
          text: { type: "plain_text" as const, text: "却下" },
        },
      ],
    });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "修正はこのスレッドに返信（例：もっと短く）" }] });
  }
  return { text: `${KIND_LABEL[v.kind]}の投稿案（${v.dayLabel}）`, blocks };
}
