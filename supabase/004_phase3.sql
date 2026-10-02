-- Phase 3（投稿パイプライン）

-- 投稿案の状態を追加: 投稿中（二重投稿防止）／投稿失敗／期限切れ（48時間承認されなかった）
alter type review_status add value if not exists 'posting';
alter type review_status add value if not exists 'post_failed';
alter type review_status add value if not exists 'expired';

-- 過去投稿の保管庫（重複チェック用。毎回 X から読み直さないため）
create table x_post_history (
  x_post_id text primary key,
  body text not null,
  posted_at timestamptz,
  metrics jsonb,
  source text not null default 'import' check (source in ('import','pipeline')),
  -- 別ツールの AI が作った日常ネタ（実話ではない）か。null = 未確定
  fabricated boolean,
  -- キーワードでの自動判定（確定前の候補）。未確定の間は、これが true なら作り話として扱う
  fabricated_suggested boolean not null default false,
  imported_at timestamptz default now()
);
alter table x_post_history enable row level security;

-- ネタのストック（personal は代表が出したネタからしか作らない）
create table post_topics (
  id bigserial primary key,
  body text not null,
  slack_channel text,
  slack_ts text unique,                    -- Slack の再送・重複イベントで二重登録しない
  status text not null default 'stock' check (status in ('stock','reserved','used','discarded')),
  draft_id bigint references post_drafts(id),
  created_at timestamptz default now(),
  used_at timestamptz
);
alter table post_topics enable row level security;

-- 投稿案: 種類・使ったネタ・狙い・投稿日の暦情報
alter table post_drafts add column kind text check (kind in ('business','personal','greeting'));
alter table post_drafts add column topic_id bigint references post_topics(id);
alter table post_drafts add column reason text;
alter table post_drafts add column target_date date;
alter table post_drafts add column day_context jsonb;

-- 投稿案のスレッドでの修正履歴
create table post_draft_revisions (
  id bigserial primary key,
  slack_ts text unique not null,           -- 指示メッセージの ts（二重処理防止）
  draft_id bigint not null references post_drafts(id),
  instruction text not null,
  body text,
  review jsonb,
  created_at timestamptz default now()
);
alter table post_draft_revisions enable row level security;

-- 効果測定: 24h / 72h の時点ごとに1回だけ
alter table post_metrics add column checkpoint text check (checkpoint in ('24h','72h'));
create unique index post_metrics_checkpoint_key on post_metrics (x_post_id, checkpoint);

-- 投稿案の構成（後から変えられる）。各スロットは「作りたい種類」の優先順。personal はネタのストックがあるときだけ
insert into settings (key, value) values
  ('post_draft_slots', '[["greeting"], ["business"], ["personal", "business"]]')
on conflict (key) do nothing;
