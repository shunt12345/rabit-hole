-- Tomorrow's hero, one pick per card. /queue now approves a pick INTO the
-- next morning's slot (publish_at = next 07:00 UTC, set by admin-review-
-- queue on approve), replacing any pick already approved for that card,
-- and clears out leftovers once every card has one. This migration:
--   1. moves the 2026-10-09 afternoon picks that were approved before
--      that existed (and so went live on approval) into tomorrow's slot;
--   2. replaces the 07:00 UTC auto-approve sweep (0046), which approved
--      EVERY pending row — leftover alternatives included, letting
--      whichever was generated last win a card — with one that only
--      fills cards nobody approved, with the newest pick for each.

-- 1. Today's early approvals → tomorrow's slot (newest per card if a card
--    got more than one).
update trending_topics_cache
set publish_at = '2026-10-10 07:00:00+00'
where status = 'approved'
  and publish_at is null
  and generated_at >= '2026-10-09 14:55:00+00';

delete from trending_topics_cache t
where t.status = 'approved'
  and t.publish_at = '2026-10-10 07:00:00+00'
  and exists (
    select 1 from trending_topics_cache n
    where n.field = t.field
      and n.status = 'approved'
      and n.publish_at = t.publish_at
      and (n.generated_at, n.id) > (t.generated_at, t.id)
  );

-- 2. The morning publish: for each card with no approved pick for this
--    morning's slot, approve its newest due pending pick; then delete
--    every other due pending pick and anything rejected.
create or replace function publish_due_trending_topics()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  slot timestamptz := (date_trunc('day', now() at time zone 'utc') at time zone 'utc') + interval '7 hours';
begin
  with newest as (
    select distinct on (field) id, field
    from trending_topics_cache
    where status = 'pending' and (publish_at is null or publish_at <= now())
    order by field, generated_at desc, id desc
  )
  update trending_topics_cache t
  set status = 'approved', publish_at = slot
  from newest n
  where t.id = n.id
    and not exists (
      select 1 from trending_topics_cache a
      where a.field = n.field and a.status = 'approved' and a.publish_at = slot
    );

  delete from trending_topics_cache
  where (status = 'pending' and (publish_at is null or publish_at <= now()))
     or status = 'rejected';
end;
$$;

select cron.schedule(
  'auto-approve-pending-trending-topics',
  '0 7 * * *',
  $$ select publish_due_trending_topics(); $$
);
