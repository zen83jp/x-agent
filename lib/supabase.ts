import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let client: SupabaseClient | undefined;

/** サーバー専用（secret key）。RLS をバイパスするのでクライアント側に渡さないこと。 */
export function db(): SupabaseClient {
  client ??= createClient(env().SUPABASE_URL, env().SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export async function getSetting<T>(key: string): Promise<T | null> {
  const { data, error } = await db().from("settings").select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return (data?.value as T | undefined) ?? null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const { error } = await db()
    .from("settings")
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}
