export type SlackEventLike = { type: string; subtype?: string; bot_id?: string; channel: string };

/** 返信アシスタントが処理するイベントか（チャンネル外・ボットの投稿・編集や削除は無視） */
export function isTargetEvent(e: SlackEventLike, channelId: string): boolean {
  if (e.channel !== channelId || e.bot_id) return false;
  if (e.subtype && e.subtype !== "file_share") return false;
  return e.type === "app_mention" || e.type === "message";
}
