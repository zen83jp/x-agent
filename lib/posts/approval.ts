import { postMessage, updateMessage, withLabel } from "../slack/client";
import { db } from "../supabase";
import { describeDay, type DayContext } from "./calendar";
import type { PostKind, ReviewNote } from "./schemas";
import type { Slot } from "./slack";
import { buildPostApprovalBlocks, type PostApprovalView } from "./slack";

export type DraftRow = {
  id: number;
  kind: PostKind;
  slot_time: Slot | null;
  target_date: string | null;
  body: string;
  reason: string | null;
  review_note: ReviewNote | null;
  review_status: string;
  topic_id: number | null;
  day_context: DayContext | null;
  scheduled_at: string | null;
  slack_channel: string | null;
  slack_ts: string | null;
  post_topics: { body: string } | { body: string }[] | null;
};

export const DRAFT_SELECT =
  "id, kind, slot_time, target_date, body, reason, review_note, review_status, topic_id, day_context, scheduled_at, slack_channel, slack_ts, post_topics!post_drafts_topic_id_fkey(body)";

export async function loadDraft(id: number): Promise<DraftRow> {
  const { data, error } = await db().from("post_drafts").select(DRAFT_SELECT).eq("id", id).single();
  if (error) throw error;
  return data as unknown as DraftRow;
}

export function viewOf(d: DraftRow, done?: string | null): PostApprovalView {
  const topic = Array.isArray(d.post_topics) ? d.post_topics[0] : d.post_topics;
  return {
    draftId: d.id,
    kind: d.kind,
    slotTime: d.slot_time,
    targetDate: d.target_date,
    dayLabel: d.day_context ? describeDay(d.day_context) : "",
    reason: d.reason,
    body: d.body,
    topic: topic?.body ?? null,
    review: d.review_note,
    done: done ?? null,
  };
}

/** 【投稿承認】を投稿し、返ってきたチャンネル ID と ts を保存する */
export async function postDraftApproval(id: number): Promise<void> {
  const d = await loadDraft(id);
  const { channel, ts } = await postMessage({ kind: "post_approval", ...buildPostApprovalBlocks(viewOf(d)) });
  const { error } = await db().from("post_drafts").update({ slack_channel: channel, slack_ts: ts }).eq("id", id);
  if (error) throw error;
}

/** 保存しておいたチャンネル ID と ts で承認メッセージを描き直す（done があればボタンを消す） */
export async function refreshDraftApproval(id: number, done?: string | null): Promise<void> {
  const d = await loadDraft(id);
  if (!d.slack_channel || !d.slack_ts) return;
  const { text, blocks } = buildPostApprovalBlocks(viewOf(d, done));
  await updateMessage({ channel: d.slack_channel, ts: d.slack_ts, ...withLabel("post_approval", text, blocks) });
}
