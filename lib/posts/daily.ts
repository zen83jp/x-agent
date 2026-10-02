import { notifyAlert } from "../slack/client";
import { db, getSetting } from "../supabase";
import { dayContext, isDayOff, jstDateOf, targetDatesFrom } from "./calendar";
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

/**
 * 期限切れの案を1件、材料として確保する（同じ種類。personal は同じネタのものを優先）。
 * reused_at を条件付きで埋めるので、同じ案を二度材料にしない。
 */
async function takeExpiredMaterial(kind: PostKind, topicId: number | null): Promise<{ body: string; reason: string | null } | null> {
  let q = db()
    .from("post_drafts")
    .select("id, body, reason")
    .eq("review_status", "expired")
    .eq("kind", kind)
    .is("reused_at", null)
    .order("id", { ascending: false })
    .limit(1);
  if (kind === "personal" && topicId) q = q.eq("topic_id", topicId);
  const { data, error } = await q;
  if (error) throw error;
  const m = data?.[0];
  if (!m) return null;
  const { data: claimed } = await db()
    .from("post_drafts")
    .update({ reused_at: new Date().toISOString() })
    .eq("id", m.id)
    .is("reused_at", null)
    .select("id");
  return claimed?.length ? { body: m.body, reason: m.reason } : null;
}

export type ScheduledResult = { today: string; skipped?: string; results: DailyResult[] };

/**
 * 平日 9:00 JST の作成。対象は翌日から次の平日までの各日（月〜木 → 翌日／金 → 土・日・月／連休前 → 休み明けまで）。
 * 土日・祝日は何もしない。日付ごとに作成済みならその日は何もしない（再実行・手動実行で二重に作らない）。
 */
export async function createScheduledDrafts(now = new Date()): Promise<ScheduledResult> {
  const today = jstDateOf(now);
  if (isDayOff(today)) return { today, skipped: "土日・祝日のため作成しません", results: [] };
  const results: DailyResult[] = [];
  for (const date of targetDatesFrom(today)) results.push(await createDailyDrafts(now, date));
  return { today, results };
}

export type DailyResult = { targetDate: string; created: { id: number; kind: PostKind }[]; failed: string[]; skipped?: string };

/**
 * 指定した投稿日の投稿案を作り、審査を通ったものを【投稿承認】に出す。
 * 同じ日付の案がすでにあれば何もしない（Cron の再実行・手動実行で二重に作らない）。
 */
export async function createDailyDrafts(now: Date, targetDate: string): Promise<DailyResult> {
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

    const material = await takeExpiredMaterial(kind, topic?.id ?? null);
    const written = await writeAndReview({ kind, day, topic: topic?.body, batchBodies, material });
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
