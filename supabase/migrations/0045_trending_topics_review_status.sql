-- Adds a review/approval gate in front of trending_topics_cache: nothing
-- the nightly cron generates (generate-trending-topics) reaches the public
-- hero page or the daily digest email until the admin explicitly approves
-- it from /admin. Everything that's already live gets backfilled as
-- 'approved' so existing content doesn't disappear -- 'approved' is also
-- the column's ongoing default, which matters for every OTHER insert path
-- in this app (the Starter Question seeds in 0035/0039, any future
-- hand-authored campaign like 0039's Stale Bread content) that isn't the
-- automated cron: those are already reviewed by construction (a human
-- wrote the exact SQL), so they publish immediately same as before.
-- generate-trending-topics is the one write path that now explicitly
-- overrides this default to 'pending' per row.
alter table trending_topics_cache
  add column if not exists status text not null default 'approved';

alter table trending_topics_cache
  add constraint trending_topics_cache_status_check
  check (status in ('pending', 'approved', 'rejected'));

create index if not exists trending_topics_cache_status_idx
  on trending_topics_cache (status, generated_at desc);

-- Replaces the old "Public can read trending topics" policy (0002) --
-- same table, same anon-key read path, but now scoped to approved rows
-- only. This is the REAL enforcement, not just a client-side filter:
-- pending/rejected rows are structurally unreadable with the anon key
-- regardless of what query string the client happens to send, so a bug
-- in App.jsx's own filtering can't leak unreviewed content.
drop policy if exists "Public can read trending topics" on trending_topics_cache;

create policy "Public can read approved trending topics"
  on trending_topics_cache for select
  using (status = 'approved');
