import { xApi } from "./client";

export type DmEvent = {
  id: string;
  event_type: string;
  text?: string;
  created_at?: string;
  sender_id?: string;
  dm_conversation_id?: string;
};

export type XUser = { id: string; name?: string; username?: string; description?: string };

type DmEventsResponse = {
  data?: DmEvent[];
  includes?: { users?: XUser[] };
  meta?: { result_count?: number; next_token?: string };
};

/** 1ページあたりの件数。ポーリングでは毎回これだけ読み、カーソルより新しいものだけを処理する */
export const DM_PAGE_SIZE = 10;

/**
 * 旧形式の DM イベント（新しい順）。暗号化された会話のメッセージは X API の仕様で含まれない。
 */
export async function listDmEvents(paginationToken?: string): Promise<{
  events: DmEvent[];
  users: XUser[];
  nextToken?: string;
}> {
  const res = await xApi<DmEventsResponse>("dm_events.list", {
    query: {
      max_results: DM_PAGE_SIZE,
      event_types: "MessageCreate",
      "dm_event.fields": "id,event_type,text,created_at,sender_id,dm_conversation_id",
      expansions: "sender_id",
      "user.fields": "name,username,description",
      pagination_token: paginationToken,
    },
  });
  return { events: res.data ?? [], users: res.includes?.users ?? [], nextToken: res.meta?.next_token };
}

/** DM を送信し、作成されたイベント ID を返す */
export async function sendDm(conversationId: string, text: string): Promise<string> {
  const res = await xApi<{ data: { dm_conversation_id: string; dm_event_id: string } }>("dm.send", {
    params: { dm_conversation_id: conversationId },
    body: { text },
  });
  return res.data.dm_event_id;
}

/** 1対1の会話 ID（"小さいID-大きいID"）から相手のユーザー ID を取り出す。グループ会話なら null */
export function counterpartId(conversationId: string, myId: string): string | null {
  const parts = conversationId.split("-");
  if (parts.length !== 2 || !parts.includes(myId)) return null;
  return parts.find((p) => p !== myId) ?? null;
}
