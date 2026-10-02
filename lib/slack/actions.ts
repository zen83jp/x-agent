import { z } from "zod";
import { EDIT_VIEW_ID, dmActionHandlers, dmSyncActionHandlers, submitEdited, validateEdited } from "../dm/actions";
import { postActionHandlers } from "../posts/actions";

/** Slack の block_actions ペイロードのうち、使う部分だけを検証する */
export const blockActionsPayload = z.object({
  type: z.literal("block_actions"),
  trigger_id: z.string().optional(),
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

/** モーダルの送信（view_submission） */
export const viewSubmissionPayload = z.object({
  type: z.literal("view_submission"),
  user: z.object({ id: z.string() }),
  view: z.object({
    callback_id: z.string(),
    private_metadata: z.string(),
    state: z.object({
      values: z.record(z.string(), z.record(z.string(), z.object({ value: z.string().nullable().optional() }))),
    }),
  }),
});

export type ViewSubmissionPayload = z.infer<typeof viewSubmissionPayload>;

export type ActionContext = {
  userId: string;
  value: string | undefined;
  channel: string;
  messageTs: string;
  triggerId?: string;
};

/**
 * 処理結果。`summary` は元メッセージのボタンを置き換えて表示される。
 * `keepButtons: true` のときはボタンを残す（例: [修正して送信] でモーダルを開くだけの場合）。
 */
export type ActionResult = { summary: string; keepButtons?: boolean; /** 表示の先頭（既定は ✅） */ icon?: string };

export type ActionHandler = (ctx: ActionContext) => Promise<ActionResult>;

/**
 * action_id → ハンドラ（レスポンス後に after() で実行）。
 * ハンドラは冪等にすること（二重押下・並行実行がありうるため、DB の状態を見て処理済みなら何もしない）。
 */
export const actionHandlers: Record<string, ActionHandler> = {
  health_ack: async () => ({ summary: "動作確認OK" }),
  ...dmActionHandlers,
  ...postActionHandlers,
};

/**
 * レスポンスを返す前に同期で実行するハンドラ。モーダルを開くもの（trigger_id は押下から3秒で失効するため）。
 */
export const syncActionHandlers: Record<string, ActionHandler> = {
  ...dmSyncActionHandlers,
};

export type ViewHandler = (args: { userId: string; privateMetadata: string; text: string }) => Promise<void>;

/**
 * callback_id → モーダル送信時のハンドラ（after() で実行）。
 * validate はモーダルを閉じる前に同期で実行し、問題があればモーダル上にその理由を表示する。
 */
export const viewHandlers: Record<
  string,
  { handler: ViewHandler; block: string; action: string; validate?: (text: string) => Promise<string | null> }
> = {
  [EDIT_VIEW_ID]: { handler: submitEdited, block: "reply", action: "reply_text", validate: validateEdited },
};
