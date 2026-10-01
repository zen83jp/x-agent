import { db, getSetting, setSetting } from "../supabase";
import { counterpartId, listDmEvents, type DmEvent, type XUser } from "../x/dm";
import { notifyAlert } from "../slack/client";
import { postApproval } from "./approval";
import { processIncoming } from "./incoming";

const CURSOR_KEY = "dm_poll_cursor";
const MAX_PAGES = 3;
/** 1回の実行で処理する新着の上限（LLM 呼び出しに時間がかかるため。残りは次の実行で） */
export const MAX_PER_RUN = 5;

/** X のイベント ID は数値の文字列。桁数が違っても正しく比べるため BigInt で比較する */
export function isNewer(id: string, cursor: string): boolean {
  return BigInt(id) > BigInt(cursor);
}

/** カーソルより新しいイベントを古い順に返す */
export function selectNewEvents(events: DmEvent[], cursor: string): DmEvent[] {
  return events
    .filter((e) => isNewer(e.id, cursor))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** このページが全部カーソルより新しければ、取りこぼしがないよう次のページも読む */
export function shouldReadNextPage(page: DmEvent[], cursor: string, nextToken: string | undefined): boolean {
  return Boolean(nextToken) && page.length > 0 && page.every((e) => isNewer(e.id, cursor));
}

export function newestId(events: DmEvent[]): string | null {
  return events.reduce<string | null>((max, e) => (max === null || isNewer(e.id, max) ? e.id : max), null);
}

async function myUserId(): Promise<string> {
  const { data, error } = await db().from("x_auth").select("x_user_id").eq("id", 1).single();
  if (error) throw error;
  return data.x_user_id;
}

export type PollResult =
  | { status: "initialized"; cursor: string | null }
  | { status: "ok"; fetched: number; processed: number; remaining: number };

export async function pollDms(): Promise<PollResult> {
  const cursor = await getSetting<string>(CURSOR_KEY);
  const me = await myUserId();

  const events: DmEvent[] = [];
  const users = new Map<string, XUser>();
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await listDmEvents(token);
    events.push(...res.events);
    res.users.forEach((u) => users.set(u.id, u));
    // 初回はカーソルを作るだけなので1ページで十分
    if (!cursor || !shouldReadNextPage(res.events, cursor, res.nextToken)) break;
    token = res.nextToken;
  }

  // 初回は過去分を処理せず、最新のイベント ID を記録するだけ
  if (!cursor) {
    const newest = newestId(events);
    if (newest) await setSetting(CURSOR_KEY, newest);
    return { status: "initialized", cursor: newest };
  }

  const fresh = selectNewEvents(events, cursor);
  const batch = fresh.slice(0, MAX_PER_RUN);
  for (const e of batch) {
    await handleEvent(e, me, users);
    await setSetting(CURSOR_KEY, e.id); // 1件ずつ進めて、途中で失敗しても処理済みを再処理しない
  }
  return { status: "ok", fetched: events.length, processed: batch.length, remaining: fresh.length - batch.length };
}

async function upsertThread(conversationId: string, counterpart: string, user: XUser | undefined): Promise<number> {
  const { data, error } = await db()
    .from("dm_threads")
    .upsert(
      {
        x_conversation_id: conversationId,
        x_user_id: counterpart,
        ...(user?.username ? { x_username: user.username } : {}),
        ...(user?.name ? { x_name: user.name } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "x_conversation_id" },
    )
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function handleEvent(e: DmEvent, me: string, users: Map<string, XUser>): Promise<void> {
  if (!e.dm_conversation_id || !e.sender_id || !e.text) return;
  const fromMe = e.sender_id === me;
  const counterpart = fromMe ? counterpartId(e.dm_conversation_id, me) : e.sender_id;
  if (!counterpart) return; // グループ会話は対象外

  const threadId = await upsertThread(e.dm_conversation_id, counterpart, fromMe ? undefined : users.get(e.sender_id));

  // x_event_id の一意制約で二重処理を防ぐ。insert できた実行だけが続きを処理する
  const { data, error } = await db()
    .from("dm_messages")
    .insert({
      x_event_id: e.id,
      thread_id: threadId,
      direction: fromMe ? "out" : "in",
      body: e.text,
      // 代表が X アプリから手で送った DM。アプリから送った DM は送信時に同じ ID で保存済みなのでここには来ない
      ...(fromMe ? { send_status: "sent", sent_at: e.created_at ?? new Date().toISOString() } : {}),
    })
    .select("id")
    .single();
  if (error?.code === "23505") return;
  if (error) throw error;

  if (!fromMe) await processSafely(data.id, threadId, e.sender_id, users.get(e.sender_id));
}

/**
 * 保存済みの DM は次の実行では重複としてスキップされるため、ここで失敗すると取りこぼす。
 * 失敗時は「要手動対応」として承認メッセージだけでも出し、それも無理ならアラートを出す。
 */
async function processSafely(messageId: number, threadId: number, senderId: string, sender: XUser | undefined) {
  try {
    await processIncoming(messageId, threadId, senderId, sender);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("processIncoming failed", messageId, e);
    try {
      await db()
        .from("dm_messages")
        .update({ needs_human_check: [`要手動対応: 処理中にエラーが発生しました（${msg}）`] })
        .eq("id", messageId);
      await postApproval(messageId);
    } catch {
      await notifyAlert(`DM（dm_messages.id=${messageId}）の処理に失敗しました。X アプリで確認してください: ${msg}`);
    }
  }
}
