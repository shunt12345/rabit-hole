-- Schedules the daily digest email (see supabase/functions/send-daily-digest)
-- once a day at 12:00 UTC (~8am US Eastern) — after both the morning news
-- refresh (11:00 UTC, see 0003) and comfortably after the nightly
-- special-fields refresh (07:00 UTC, see 0004), so the digest always has
-- same-day content rather than yesterday's.
--
-- Reuses the SAME 'cron_secret' Vault entry generate-trending-topics
-- already reads (see 0003_generate_trending_topics_cron.sql) — one shared
-- secret authenticates every cron-only function's own scheduled calls,
-- rather than a separate secret per job.
select cron.schedule(
  'send-daily-digest',
  '0 12 * * *',
  $$
  select net.http_post(
    url := 'https://gflcioanuzrxgxxafnzl.supabase.co/functions/v1/send-daily-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
