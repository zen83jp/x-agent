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
  SLACK_CHANNEL_DM: z.string().min(1),
  SLACK_CHANNEL_POSTS: z.string().min(1),
  SLACK_CHANNEL_ALERTS: z.string().min(1),

  MEETING_URL: z.string().url(),
  CRON_SECRET: z.string().min(16),
  ADMIN_SECRET: z.string().min(16),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * 環境変数を検証して返す。ビルド時に失敗しないよう、初回呼び出し時に検証する。
 */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`環境変数が不足または不正です: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}
