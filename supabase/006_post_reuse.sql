-- 期限切れの投稿案を、次回の作成で材料（参考）として使った日時。同じ案を二度材料にしない
alter table post_drafts add column reused_at timestamptz;
