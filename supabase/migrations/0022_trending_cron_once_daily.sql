-- Scales generate-trending-topics' NEWS_FIELDS run back from twice a day to
-- once — same cadence as the special-fields job (0004_generate_trending_topics_
-- special_cron.sql), which has always run once nightly.
--
-- Runs at 07:00 UTC, the SAME time as that special-fields job, not the old
-- "AM" 11:00 UTC slot 0003 originally used — 11:00 UTC is AFTER
-- send-daily-digest's 09:00 UTC send (0021), which would have meant every
-- digest email going out with a stale, previous-day Trending pick until
-- 11:00 rolled around. 07:00 keeps the same 2-hour buffer before the
-- digest that the special fields job has always relied on, and now both
-- halves of "Trending" + "Today" refresh together in one batch instead of
-- at two different times of the morning.
--
-- cron.schedule() with the SAME job name ('generate-trending-topics')
-- updates the existing job in place rather than creating a second one —
-- same idiom 0003 itself used to originally create it.
select cron.schedule(
  'generate-trending-topics',
  '0 7 * * *',
  $$
  select net.http_post(
    url := 'https://gflcioanuzrxgxxafnzl.supabase.co/functions/v1/generate-trending-topics',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
