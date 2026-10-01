import { z } from "zod";

/** Slack の block_actions ペイロードのうち、使う部分だけを検証する */
export const blockActionsPayload = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string(), username: z.string().optional(), name: z.string().optional() }),
  container: z.object({ channel_id: z.string(), message_ts: z.string() }),
  message: z
    .object({ text: z.string().optional(), blocks: z.array(z.record(z.string(), z.unknown())).optional() })
    .optional(),
  actions: z
    .array(z.object({ action_id: z.string(), value: z.string().optional() }))
    .min(1),
});

export type BlockActionsPayload = z.infer<typeof blockActionsPayload>;

export type ActionContext = {
  userId: string;
  value: string | undefined;
  channel: string;
  messageTs: string;
};

/**
 * 処理結果。`summary` は元メッセージのボタンを置き換えて表示される。
 * `keepButtons: true` のときはボタンを残す（例: [修正して送信] でモーダルを開くだけの場合）。
 */
export type ActionResult = { summary: string; keepButtons?: boolean };

export type ActionHandler = (ctx: ActionContext) => Promise<ActionResult>;

/**
 * action_id → ハンドラ。Phase 2 以降はここに追加する。
 * ハンドラは冪等にすること（二重押下・並行実行がありうるため、DB の状態を見て処理済みなら何もしない）。
 */
export const actionHandlers: Record<string, ActionHandler> = {
  health_ack: async () => ({ summary: "動作確認OK" }),
};
