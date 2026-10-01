-- Slack メッセージの更新（chat.update）には ts と送信先チャンネル ID の両方が要る。
-- 送信時に返ってきたチャンネル ID を ts と一緒に保存する。
alter table dm_messages add column slack_channel text;
alter table post_drafts add column slack_channel text;
