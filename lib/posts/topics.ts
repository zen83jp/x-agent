import { db } from "../supabase";

/** `ネタ：〇〇` / `ネタ:〇〇` の本文を取り出す。ネタの投稿でなければ null */
export function parseTopic(text: string): string | null {
  const m = text.trim().match(/^ネタ\s*[：:]\s*([\s\S]+)$/);
  return m ? m[1]!.trim() || null : null;
}

export function isTopicListCommand(text: string): boolean {
  return /^ネタ一覧\s*$/.test(text.trim());
}

/** ネタを保存する。同じ Slack メッセージは1回だけ（再送・重複イベント対策）。保存できたら true */
export async function saveTopic(body: string, channel: string, ts: string): Promise<boolean> {
  const { error } = await db().from("post_topics").insert({ body, slack_channel: channel, slack_ts: ts });
  if (error?.code === "23505") return false;
  if (error) throw error;
  return true;
}

export async function stockTopics(): Promise<{ id: number; body: string; created_at: string }[]> {
  const { data, error } = await db()
    .from("post_topics")
    .select("id, body, created_at")
    .eq("status", "stock")
    .order("id");
  if (error) throw error;
  return data ?? [];
}

/** 一番古いストックを1件確保する（並行実行でも同じネタを二重に使わない） */
export async function reserveTopic(): Promise<{ id: number; body: string } | null> {
  for (const t of await stockTopics()) {
    const { data, error } = await db()
      .from("post_topics")
      .update({ status: "reserved" })
      .eq("id", t.id)
      .eq("status", "stock")
      .select("id, body");
    if (error) throw error;
    if (data?.length) return data[0]!;
  }
  return null;
}

/** 却下・期限切れ・作成失敗のとき、ネタをストックに戻す */
export async function releaseTopic(topicId: number | null | undefined): Promise<void> {
  if (!topicId) return;
  const { error } = await db()
    .from("post_topics")
    .update({ status: "stock", draft_id: null })
    .eq("id", topicId)
    .eq("status", "reserved");
  if (error) throw error;
}

export async function markTopicUsed(topicId: number | null | undefined): Promise<void> {
  if (!topicId) return;
  const { error } = await db()
    .from("post_topics")
    .update({ status: "used", used_at: new Date().toISOString() })
    .eq("id", topicId);
  if (error) throw error;
}
