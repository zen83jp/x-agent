import { notifyAlert } from "../slack/client";
import { db, getSetting } from "../supabase";
import { dayContext, isGenerationDay, jstDateOf, weeklyTargetDates } from "./calendar";
import { postDraftApproval } from "./approval";
import { POST_KINDS, type PostKind } from "./schemas";
import { SLOTS, slotTimeForIndex, type Slot } from "./slack";
import { releaseTopic, reserveTopic } from "./topics";
import { writeAndReview } from "./writer";

/** 既定の構成: greeting 1＋business 1＋（ネタがあれば personal、なければ business）1 */
export const DEFAULT_SLOTS: PostKind[][] = [["greeting"], ["business"], ["personal", "business"]];

/**
 * settings.post_draft_slots を検証して返す（不正なら既定値）。
 * 枠は投稿時刻（7:30／12:10／20:30）と1対1なので、最大3枠
 */
export function parseSlots(value: unknown): PostKind[][] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SLOTS.length) return DEFAULT_SLOTS;
  const slots = value.map((s) => (Array.isArray(s) ? s.filter((k): k is PostKind => POST_KINDS.includes(k)) : []));
  return slots.every((s) => s.length > 0) ? slots : DEFAULT_SLOTS;
}

/**
 * 切り替えのため、自動の週生成（Cron）はこの日から動かす。2026-10-08（木）に push した時点で 17:00 の自動生成を
 * 動かさず、10/10〜10/18 は管理者が手動で生成するため。10/15 以降は不要なので、次の変更のときに消してよい
 */
export const WEEKLY_AUTO_START = "2026-10-15";

/** 1回の実行で使う時間の目安。Vercel の上限（300秒）と、5分おきの次の実行に重ならないよう短めにとる */
export const RUN_BUDGET_MS = 180_000;

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

/** 日付×枠の印（"2026-10-12|07:30"） */
const slotKey = (date: string, slot: Slot | string) => `${date}|${slot}`;

/**
 * 作成済みの枠。状態に関係なく（承認待ち・承認済み・投稿済み・却下・期限切れ・投稿失敗）、案がある枠は作り直さない
 */
export async function existingSlots(dates: string[]): Promise<Set<string>> {
  if (dates.length === 0) return new Set();
  const { data, error } = await db()
    .from("post_drafts")
    .select("target_date, slot_time")
    .in("target_date", dates)
    .not("slot_time", "is", null);
  if (error) throw error;
  return new Set((data ?? []).map((d) => slotKey(d.target_date, d.slot_time)));
}

/** 作るべき枠（日付×枠のうち、まだ案が無いもの）を、日付・枠の順に並べる */
export function missingSlots(dates: string[], slotCount: number, existing: Set<string>): { date: string; index: number; slot: Slot }[] {
  const out: { date: string; index: number; slot: Slot }[] = [];
  for (const date of dates) {
    for (let index = 0; index < slotCount; index++) {
      const slot = slotTimeForIndex(index);
      if (!existing.has(slotKey(date, slot))) out.push({ date, index, slot });
    }
  }
  return out;
}

export type GenerationResult = {
  today: string;
  skipped?: string;
  created: { id: number; date: string; slot: Slot; kind: PostKind }[];
  failed: string[];
  /** 時間切れで今回作らなかった枠の数（次の実行で続きから作る） */
  remaining: number;
};

/** 1枠ぶんの投稿案を作って【投稿承認】に出す。作れなければ理由を返す */
async function createSlot(date: string, index: number, slot: Slot, prefs: PostKind[]): Promise<{ id: number; kind: PostKind } | { failed: string }> {
  const day = dayContext(date);
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
  if (!kind) return { failed: `${date} ${slot}: 作れる種類がありません` };

  const material = await takeExpiredMaterial(kind, topic?.id ?? null);
  const written = await writeAndReview({ kind, day, topic: topic?.body, material });
  if ("failed" in written) {
    await releaseTopic(topic?.id);
    return { failed: `${date} ${slot} ${kind}: ${written.failed}` };
  }

  // 並行実行で同じ枠がすでに作られていたら、作った案は捨てる（枠ごとに1案）
  if ((await existingSlots([date])).has(slotKey(date, slot))) {
    await releaseTopic(topic?.id);
    return { failed: `${date} ${slot}: ほかの実行で作成済み（今回の案は破棄）` };
  }
  const { data, error } = await db()
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
      target_date: date,
      day_context: day,
    })
    .select("id")
    .single();
  if (error) {
    await releaseTopic(topic?.id);
    throw error;
  }
  if (topic) await db().from("post_topics").update({ draft_id: data.id }).eq("id", topic.id);
  await postDraftApproval(data.id);
  return { id: data.id, kind };
}

/**
 * 指定した日付の、まだ案が無い枠を作る（枠単位で判定。却下・期限切れの枠は作り直さない）。
 * 時間の目安（RUN_BUDGET_MS）を過ぎたら、残りは次の実行に回す。
 */
export async function createMissingDrafts(dates: string[], now = new Date(), budgetMs = RUN_BUDGET_MS): Promise<GenerationResult> {
  const started = Date.now();
  const today = jstDateOf(now);
  const slots = parseSlots(await getSetting("post_draft_slots"));
  const missing = missingSlots(dates, slots.length, await existingSlots(dates));

  const missingHolidayYears = [...new Set(dates.filter((d) => dayContext(d).holidayDataMissing).map((d) => d.slice(0, 4)))];
  if (missingHolidayYears.length) {
    await notifyAlert(`${missingHolidayYears.join("・")}年の祝日表がありません（lib/posts/calendar.ts を更新してください）`);
  }

  const created: GenerationResult["created"] = [];
  const failed: string[] = [];
  let done = 0;
  for (const m of missing) {
    if (Date.now() - started > budgetMs) break;
    done++;
    const r = await createSlot(m.date, m.index, m.slot, slots[m.index]!);
    if ("failed" in r) failed.push(r.failed);
    else created.push({ id: r.id, date: m.date, slot: m.slot, kind: r.kind });
  }

  if (failed.length) {
    await notifyAlert(
      `投稿案のうち ${failed.length} 件を作れませんでした。次の実行で自動的に作り直します（続けて失敗する場合は要手動対応）\n${failed.map((f) => `• ${f}`).join("\n")}`,
    );
  }
  return { today, created, failed, remaining: missing.length - done };
}

/**
 * 週1回の生成（Cron: 月〜木 17:00〜17:55 JST に5分おき）。
 * 生成する日（原則木曜、休みなら直前の平日）だけ動き、翌日から翌週の日曜までの、まだ案が無い枠を作る。
 * force（管理用の手動実行）なら、生成する日でなくても同じ範囲を作る。
 */
export async function createWeeklyDrafts(opts: { now?: Date; force?: boolean; budgetMs?: number } = {}): Promise<GenerationResult> {
  const now = opts.now ?? new Date();
  const today = jstDateOf(now);
  if (!opts.force && !isGenerationDay(today)) {
    return { today, skipped: "生成する日ではありません", created: [], failed: [], remaining: 0 };
  }
  if (!opts.force && today < WEEKLY_AUTO_START) {
    return { today, skipped: `自動の週生成は ${WEEKLY_AUTO_START} から（切り替え中）`, created: [], failed: [], remaining: 0 };
  }
  return createMissingDrafts(weeklyTargetDates(today), now, opts.budgetMs);
}
