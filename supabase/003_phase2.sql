-- Phase 2（DM：旧形式のポーリング＋暗号化 DM の返信アシスタント）

-- X の課金は「同じリソースは UTC 日内で1回」。今日すでに課金されたリソースを記録して重複計上を防ぐ
create table x_billed_resources (
  utc_day date not null,
  resource_type text not null,
  resource_id text not null,
  primary key (utc_day, resource_type, resource_id)
);
alter table x_billed_resources enable row level security;

-- DM（旧形式）の承認フロー
alter table dm_messages add column send_status text default 'pending'
  check (send_status in ('pending','sending','sent','skipped','failed'));
alter table dm_messages add column classification jsonb;
alter table dm_messages add column decline_reply text;
alter table dm_messages add column needs_human_check jsonb;
alter table dm_threads add column x_username text;
alter table dm_threads add column x_name text;

-- リード: 暗号化 DM（Slack 返信アシスタント）からは X のユーザー ID が分からないため NULL 可にし、
-- @ユーザー名（@ なし・小文字）で名寄せする
alter table leads alter column x_user_id drop not null;
alter table leads add column display_name text;
alter table leads add column source text default 'dm_poll' check (source in ('dm_poll','slack_assist'));
create unique index leads_x_username_key on leads (lower(x_username)) where x_username is not null;

-- 修正率ビュー: 代表が X アプリから手動で送った DM（edited_by_human is null）は母数から除く
create or replace view dm_edit_rate with (security_invoker = true) as
select category,
       count(*) as replies,
       round(avg(case when edited_by_human then 1 else 0 end)::numeric, 2) as edit_rate
from dm_messages
where direction = 'out' and edited_by_human is not null
group by category;

-- 暗号化 DM の返信アシスタント（Slack でメンション → 分類・返信案をスレッドに返す）
create table dm_assists (
  id bigserial primary key,
  slack_channel text not null,
  slack_ts text unique not null,          -- スレッドの親。二重処理防止（Slack の再送・重複イベント対策）も兼ねる
  input_type text not null check (input_type in ('text','image')),
  extracted jsonb,                         -- { screenshot?: 読み取り結果, context: 分類・返信案の入力 }（作り直しで再利用）
  classification jsonb,
  reply jsonb,
  lead_id bigint references leads(id),
  created_at timestamptz default now()
);
alter table dm_assists enable row level security;

create table dm_assist_revisions (
  id bigserial primary key,
  slack_ts text unique not null,          -- 指示メッセージの ts。メンション付きの返信は2種類のイベントで届くため、ts で1回に絞る
  assist_id bigint not null references dm_assists(id),
  instruction text not null,
  reply jsonb,
  created_at timestamptz default now()
);
alter table dm_assist_revisions enable row level security;
