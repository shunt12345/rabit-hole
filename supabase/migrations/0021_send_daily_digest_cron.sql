-- Schedules the daily digest email (see supabase/functions/send-daily-digest)
-- once a day at 9:00 UTC = 5:00 AM US Eastern (currently EDT, UTC-4) — a
-- fixed UTC cron expression can't itself follow DST, so this will read as
-- 4:00 AM Eastern for the EST months (roughly Nov-Mar); update this
-- expression by an hour at each DST changeover if that hour matters, same
-- caveat as any fixed-UTC cron schedule tied to a US-local time.
--
-- Tradeoff worth knowing: this lands BEFORE the day's freshest Trending
-- refresh (11:00 UTC, see 0003) — at 9:00 UTC the newest available
-- Trending content is still from the previous run (01:00 UTC, the night
-- before), not stale exactly, just not the latest cycle. Picked 5am ET
-- anyway since an early-morning send mattered more here than having the
-- absolute latest Trending picks; the nightly special-fields refresh
-- (07:00 UTC, see 0004) IS already in by 9:00, so Today's content is
-- always fully current.
--
-- Reuses the SAME 'cron_secret' Vault entry generate-trending-topics
-- already reads (see 0003_generate_trending_topics_cron.sql) — one shared
-- secret authenticates every cron-only function's own scheduled calls,
-- rather than a separate secret per job.
-- Includes the anon/publishable key as a bearer token, not just
-- x-cron-secret — confirmed live that without it, Supabase's own gateway
-- rejects the call with 401 UNAUTHORIZED_NO_AUTH_HEADER before this
-- function's code (which checks x-cron-secret itself) ever runs, unless
-- "Enforce JWT Verification" happens to be off for this specific function.
-- Rather than depend on that per-function dashboard toggle being set
-- correctly, this just always sends a valid key too. The anon/publishable
-- key is meant to be public (it's already embedded in the shipped client
-- bundle), so committing it here isn't a new exposure.
select cron.schedule(
  'send-daily-digest',
  '0 9 * * *',
  $$
  select net.http_post(
    url := 'https://gflcioanuzrxgxxafnzl.supabase.co/functions/v1/send-daily-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_jBvdkmRyqjTStx85VNXikw_4ocLNZRf',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
