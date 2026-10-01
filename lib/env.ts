import { z } from "zod";

const schema = z.object({
  X_CLIENT_ID: z.string().min(1),
  X_CLIENT_SECRET: z.string().min(1),
  X_REDIRECT_URI: z.string().url(),
  X_DAILY_BUDGET_USD: z.coerce.number().nonnegative(),

  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().min(1),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_SIGNING_SECRET: z.string().min(1),
  /** 承認・通知をすべて送るチャンネル（C から始まる ID） */
  SLACK_CHANNEL_ID: z.string().regex(/^C[A-Z0-9]+$/, "C から始まるチャンネル ID"),

  MEETING_URL: z.string().url(),
  CRON_SECRET: z.string().min(16),
  ADMIN_SECRET: z.string().min(16),
});

export type Env = z.infer<typeof schema>;

const cache: Partial<Env> = {};

const proxy = new Proxy(cache, {
  get(target, prop) {
    if (typeof prop !== "string" || !(prop in schema.shape)) return undefined;
    const key = prop as keyof Env;
    if (key in target) return target[key];
    const parsed = schema.shape[key].safeParse(process.env[key]);
    if (!parsed.success) throw new Error(`環境変数が不足または不正です: ${key}`);
    return ((target as Record<string, unknown>)[key] = parsed.data);
  },
}) as Env;

/**
 * 環境変数を返す。読まれた変数だけをその時点で検証する。
 * ビルド時に失敗せず、設定済みのサービス（例: Slack だけ）から順に動作確認できるようにするため。
 */
export function env(): Env {
  return proxy;
}
