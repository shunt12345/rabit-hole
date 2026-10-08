-- Approving a pick on /queue used to publish it the moment it was
-- approved, so a batch generated at 15:00 UTC for the next day went live
-- the same day whenever it was reviewed early. Each row now carries the
-- time it's meant to go live (publish_at, set by generate-trending-topics
-- to the next 07:00 UTC — the same slot as the auto-approve sweep from
-- 0046), and the public read policy hides an approved row until then.
-- Approving is now "scheduled for the morning", not "live now". Rows with
-- no publish_at (everything already live, hand-authored seeds) are
-- unaffected.
alter table trending_topics_cache
  add column if not exists publish_at timestamptz;

drop policy if exists "Public can read approved trending topics" on trending_topics_cache;
create policy "Public can read published trending topics"
  on trending_topics_cache for select
  using (status = 'approved' and (publish_at is null or publish_at <= now()));

-- Anything still waiting in the queue goes out with the next morning's
-- batch rather than whenever it happens to be approved.
update trending_topics_cache
set publish_at = case
  when now() < date_trunc('day', now() at time zone 'utc') at time zone 'utc' + interval '7 hours'
    then date_trunc('day', now() at time zone 'utc') at time zone 'utc' + interval '7 hours'
  else date_trunc('day', now() at time zone 'utc') at time zone 'utc' + interval '31 hours'
end
where status = 'pending' and publish_at is null;
