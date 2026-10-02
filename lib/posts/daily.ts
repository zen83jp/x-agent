import { notifyAlert } from "../slack/client";
import { db, getSetting } from "../supabase";
import { dayContext, jstDateOf } from "./calendar";
import { postDraftApproval } from "./approval";
import { POST_KINDS, type PostKind } from "./schemas";
import { slotTimeForIndex } from "./slack";
import { releaseTopic, reserveTopic } from "./topics";
import { writeAndReview } from "./writer";

/** 既定の構成: greeting 1＋business 1＋（ネタがあれば personal、なければ business）1 */
export const DEFAULT_SLOTS: PostKind[][] = [["greeting"], ["business"], ["personal", "business"]];

/** settings.post_draft_slots を検証して返す（不正なら既定値） */
export function parseSlots(value: unknown): PostKind[][] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5) return DEFAULT_SLOTS;
  const slots = value.map((s) => (Array.isArray(s) ? s.filter((k): k is PostKind => POST_KINDS.includes(k)) : []));
  return slots.every((s) => s.length > 0) ? slots : DEFAULT_SLOTS;
}

/** 翌日（JST）の日付 */
export function nextJstDate(now: Date): string {
  return jstDateOf(new Date(now.getTime() + 24 * 60 * 60 * 1000));
}

export type DailyResult = { targetDate: string; created: { id: number; kind: PostKind }[]; failed: string[]; skipped?: string };

/**
 * 翌日分の投稿案を作り、審査を通ったものを【投稿承認】に出す（毎日 21:00 JST）。
 * 同じ日付の案がすでにあれば何もしない（Cron の再実行で二重に作らない）。
 */
export async function createDailyDrafts(now = new Date(), targetDate = nextJstDate(now)): Promise<DailyResult> {
  const { count, error } = await db()
    .from("post_drafts")
    .select("id", { count: "exact", head: true })
    .eq("target_date", targetDate);
  if (error) throw error;
  if (count) return { targetDate, created: [], failed: [], skipped: "作成済み" };

  const day = dayContext(targetDate);
  if (day.holidayDataMissing) await notifyAlert(`${targetDate.slice(0, 4)}年の祝日表がありません（lib/posts/calendar.ts を更新してください）`);
  const slots = parseSlots(await getSetting("post_draft_slots"));

  const created: DailyResult["created"] = [];
  const failed: string[] = [];
  const batchBodies: string[] = [];
  for (const [index, prefs] of slots.entries()) {
    let kind: PostKind | null = null;
    let topic: { id: number; body: string } | null = null;
    for (const k of prefs) {
      if (k !== "personal") {
        kind = k;
        break;
      }
      topic = await reserveTopic();
      if (topic) {
        kind = "personal";
        break;
      }
    }
    if (!kind) continue;

    const written = await writeAndReview({ kind, day, topic: topic?.body, batchBodies });
    if ("failed" in written) {
      await releaseTopic(topic?.id);
      failed.push(`${kind}: ${written.failed}`);
      continue;
    }
    const { data, error: insErr } = await db()
      .from("post_drafts")
      .insert({
        kind,
        slot_time: slotTimeForIndex(index),
        body: written.body,
        reason: written.reason,
        theme: written.theme,
        review_note: written.review,
        review_status: "awaiting_approval",
        topic_id: topic?.id ?? null,
        target_date: targetDate,
        day_context: day,
      })
      .select("id")
      .single();
    if (insErr) {
      await releaseTopic(topic?.id);
      throw insErr;
    }
    if (topic) await db().from("post_topics").update({ draft_id: data.id }).eq("id", topic.id);
    await postDraftApproval(data.id);
    batchBodies.push(written.body);
    created.push({ id: data.id, kind });
  }

  if (failed.length) {
    await notifyAlert(`${targetDate} の投稿案のうち ${failed.length} 件を作れませんでした（要手動対応）\n${failed.map((f) => `• ${f}`).join("\n")}`);
  }
  return { targetDate, created, failed };
}
