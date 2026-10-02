import type { KnownBlock } from "@slack/web-api";
import { esc } from "../dm/slack";
import type { PostKind, ReviewNote } from "./schemas";

/** 投稿時刻の候補（JST） */
export const SLOTS = ["07:30", "12:10", "20:30"] as const;
export type Slot = (typeof SLOTS)[number];

/** 種類ごとの承認ボタンの並び（先頭が推奨の時刻） */
export const SLOT_ORDER: Record<PostKind, Slot[]> = {
  greeting: ["07:30", "12:10", "20:30"],
  business: ["12:10", "20:30", "07:30"],
  personal: ["20:30", "12:10", "07:30"],
};

const KIND_LABEL: Record<PostKind, string> = {
  greeting: "朝の挨拶（greeting）",
  business: "学び・経営（business）",
  personal: "日常（personal）",
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** その時刻（JST）の次の発生時刻。今より後で最も近いもの */
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
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}（${wd}）${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
}

export type PostApprovalView = {
  draftId: number;
  kind: PostKind;
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
      elements: [{ type: "mrkdwn", text: `*${KIND_LABEL[v.kind]}* ｜ ${esc(v.dayLabel)} 向け` }],
    },
  ];
  if (v.reason) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `狙い: ${esc(v.reason)}` }] });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: quote(v.body) } });
  if (v.topic) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `元のネタ: ${esc(v.topic)}` }] });
  }
  const notes = [
    ...(v.review?.issues ?? []).map((i) => `審査で直した点（${i.type}）: ${i.detail}`),
    ...(v.review?.warnings ?? []),
  ];
  if (notes.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*要確認*\n${notes.map((n) => `• ${esc(n)}`).join("\n")}` } });
  }
  if (v.done) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: v.done }] });
  } else {
    blocks.push({
      type: "actions",
      elements: [
        ...SLOT_ORDER[v.kind].map((slot, i) => ({
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
