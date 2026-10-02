-- 投稿案の「枠」の既定時刻（1枠目 7:30／2枠目 12:10／3枠目 20:30）。承認ボタンの先頭に使う
alter table post_drafts add column slot_time text check (slot_time in ('07:30','12:10','20:30'));

-- 既存の投稿案に、同じ日付の中での作成順で枠の時刻を入れる
with ranked as (
  select id, row_number() over (partition by target_date order by id) as n
  from post_drafts
  where target_date is not null
)
update post_drafts p
set slot_time = (array['07:30','12:10','20:30'])[least(r.n, 3)]
from ranked r
where p.id = r.id;
