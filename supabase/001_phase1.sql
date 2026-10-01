-- Phase 1 追加分（schema.sql の後に実行）

-- 全テーブルで RLS を有効化。ポリシーは作らない＝anon / authenticated からは読み書き不可、
-- サーバー（secret key）経由のアクセスのみ許可。
alter table settings      enable row level security;
alter table x_auth        enable row level security;
alter table x_api_usage   enable row level security;
alter table style_guide   enable row level security;
alter table insights      enable row level security;
alter table post_drafts   enable row level security;
alter table posts         enable row level security;
alter table post_metrics  enable row level security;
alter table leads         enable row level security;
alter table dm_threads    enable row level security;
alter table dm_messages   enable row level security;
alter table faq           enable row level security;

-- ビューは作成者権限で動くため、呼び出し元の権限で評価させる
alter view dm_edit_rate set (security_invoker = true);

-- 日次予算チェック用
create index x_api_usage_called_at_idx on x_api_usage (called_at);

-- refresh token を最後に更新した時刻（競合検知・調査用）
alter table x_auth add column updated_at timestamptz default now();

-- X API のレスポンスステータス（失敗呼び出しの調査用。成功・失敗とも記録する）
alter table x_api_usage add column status int;
