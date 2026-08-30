-- Second cron schedule for generate-trending-topics, covering only the
-- date-anchored fields ("National Day", "This Day In History") — see
-- 0003_generate_trending_topics_cron.sql for the original twice-daily job,
-- which now covers just the news fields (World News / Science /
-- Technology). These two don't need the news cadence: they only change
-- once a day, so this runs once, late at night, so a fresh pair is ready
-- before anyone's up in the morning.
--
-- 07:00 UTC = ~3am US Eastern (currently EDT, UTC-4) — same one-user
-- calibration and same DST caveat as the existing job: EDT/EST flips twice
-- a year and pg_cron runs on fixed UTC, so this needs the same manual ±1
-- hour nudge (cron.alter_job) at each transition until this is done
-- properly per-visitor.
select cron.schedule(
  'generate-trending-topics-special',
  '0 7 * * *',
  $$
  select net.http_post(
    url := 'https://gflcioanuzrxgxxafnzl.supabase.co/functions/v1/generate-trending-topics',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1)
    ),
    body := jsonb_build_object('fields', jsonb_build_array('National Day', 'This Day In History'))
  );
  $$
);
