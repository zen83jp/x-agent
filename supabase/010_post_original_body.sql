-- 投稿案の原文と、修正前の本文を残す（「原文に戻して」「1つ前に戻して」と、のちの修正の傾向の分析に使う）
alter table post_draft_revisions add column previous_body text;
alter table post_drafts add column original_body text;

-- 既存の案のうち、一度も修正されていない案は、今の本文が原文
update post_drafts p
set original_body = p.body
where p.original_body is null
  and p.kind is not null
  and not exists (select 1 from post_draft_revisions r where r.draft_id = p.id);

-- 既存の修正のうち2回目以降は、ひとつ前の（本文が保存されている）修正の、修正後の本文が「修正前」
update post_draft_revisions r
set previous_body = (
  select prev.body from post_draft_revisions prev
  where prev.draft_id = r.draft_id and prev.id < r.id and prev.body is not null
  order by prev.id desc
  limit 1
)
where r.previous_body is null;
