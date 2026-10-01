-- X エージェントチーム スキーマ

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);
insert into settings (key, value) values
  ('dm_auto_reply_enabled', 'false'),
  ('auto_reply_categories', '["faq"]');

create table x_auth (
  id int primary key default 1,
  x_user_id text not null,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  constraint single_row check (id = 1)
);

create table x_api_usage (
  id bigserial primary key,
  endpoint text not null,
  units int not null default 1,
  est_cost_usd numeric(10,4) not null,
  called_at timestamptz default now()
);

create table style_guide (
  id bigserial primary key,
  version int not null,
  content text not null,
  approved boolean default false,
  created_at timestamptz default now()
);

create table insights (
  id bigserial primary key,
  period_start date not null,
  period_end date not null,
  summary text not null,
  top_patterns jsonb,
  created_at timestamptz default now()
);

create type review_status as enum ('pending_review','needs_fix','rejected_by_ai','awaiting_approval','approved','rejected','posted');

create table post_drafts (
  id bigserial primary key,
  body text not null,
  intent_tag text check (intent_tag in ('awareness','trust','inquiry')),
  theme text,
  review_status review_status default 'pending_review',
  review_note jsonb,
  slack_ts text,
  scheduled_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz default now()
);

create table posts (
  x_post_id text primary key,
  draft_id bigint references post_drafts(id),
  body text not null,
  posted_at timestamptz default now()
);

create table post_metrics (
  id bigserial primary key,
  x_post_id text references posts(x_post_id),
  impressions int, likes int, reposts int, replies int, bookmarks int, profile_clicks int,
  captured_at timestamptz default now()
);

create table leads (
  id bigserial primary key,
  x_user_id text unique not null,
  x_username text,
  company text,
  need text,
  stage text default 'new' check (stage in ('new','contacted','meeting_set','proposal','won','lost')),
  next_action text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table dm_threads (
  id bigserial primary key,
  x_conversation_id text unique not null,
  x_user_id text not null,
  category text,
  status text default 'open' check (status in ('open','waiting_approval','replied','escalated','closed')),
  lead_id bigint references leads(id),
  last_auto_reply_at timestamptz,
  updated_at timestamptz default now()
);

create table dm_messages (
  id bigserial primary key,
  x_event_id text unique not null,      -- 二重処理防止
  thread_id bigint references dm_threads(id),
  direction text check (direction in ('in','out')),
  body text not null,
  category text,
  confidence numeric(3,2),
  draft_reply text,
  final_reply text,
  edited_by_human boolean,
  slack_ts text,
  sent_at timestamptz,
  created_at timestamptz default now()
);

create table faq (
  id bigserial primary key,
  question text not null,
  answer text not null,
  active boolean default true
);

-- 自動返信解放の判断用：カテゴリ別の人手修正率
create view dm_edit_rate as
select category,
       count(*) filter (where direction = 'out') as replies,
       round(avg(case when edited_by_human then 1 else 0 end)::numeric, 2) as edit_rate
from dm_messages
where direction = 'out'
group by category;
