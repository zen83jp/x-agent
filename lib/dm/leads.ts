import { db } from "../supabase";
import type { Category, Classification } from "./schemas";

/** リードを自動登録するカテゴリ（①②共通） */
export const LEAD_CATEGORIES: readonly Category[] = ["inquiry_detailed", "quote_contract"];

export function isLeadCategory(c: Category): boolean {
  return LEAD_CATEGORIES.includes(c);
}

/** `@Foo_Bar` → `foo_bar`。X のユーザー名として不正なら null（読み取りミスで別人と名寄せしないため） */
export function normalizeUsername(raw: string | null | undefined): string | null {
  const u = raw?.trim().replace(/^@/, "").toLowerCase();
  return u && /^[a-z0-9_]{1,15}$/.test(u) ? u : null;
}

export type LeadInput = {
  xUserId?: string | null;
  username?: string | null;
  displayName?: string | null;
  classification: Classification;
  note?: string | null;
  source: "dm_poll" | "slack_assist";
};

type LeadRow = { id: number; x_user_id: string | null };

async function findBy(column: "x_user_id" | "x_username", value: string): Promise<LeadRow | null> {
  const { data, error } = await db().from("leads").select("id, x_user_id").eq(column, value).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * リードを登録または更新して id を返す。
 * 名寄せの順: X のユーザー ID → @ユーザー名（小文字）→ 新規。
 * ②（スクショ）で先に @ユーザー名だけで登録されたリードは、①で ID が分かった時点で ID を埋めて1件にまとめる。
 */
export async function upsertLead(input: LeadInput, retried = false): Promise<number> {
  const username = normalizeUsername(input.username);
  const fields = {
    ...(username ? { x_username: username } : {}),
    ...(input.displayName ? { display_name: input.displayName } : {}),
    ...(input.classification.company ? { company: input.classification.company } : {}),
    ...(input.classification.need ? { need: input.classification.need } : {}),
    ...(input.note ? { next_action: input.note } : {}),
    updated_at: new Date().toISOString(),
  };

  const existing =
    (input.xUserId ? await findBy("x_user_id", input.xUserId) : null) ??
    (username ? await findBy("x_username", username) : null);

  if (existing) {
    const { error } = await db()
      .from("leads")
      .update({ ...fields, ...(input.xUserId && !existing.x_user_id ? { x_user_id: input.xUserId } : {}) })
      .eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  }

  const { data, error } = await db()
    .from("leads")
    .insert({ ...fields, x_user_id: input.xUserId ?? null, source: input.source })
    .select("id")
    .single();
  // 並行実行で先に登録された → 1回だけ更新側に回る
  if (error?.code === "23505" && !retried) return upsertLead(input, true);
  if (error) throw error;
  return data.id;
}
