-- Scales generate-trending-topics' NEWS_FIELDS run back from twice a day to
-- once — same cadence as the special-fields job (0004_generate_trending_topics_
-- special_cron.sql), which has always run once nightly. Keeps the AM slot
-- (11:00 UTC = ~7am US Eastern) and drops the PM one (01:00 UTC = ~9pm US
-- Eastern) that 0003 originally scheduled — a morning refresh is what
-- actually matters for "fresh by the time anyone's up," and running twice
-- daily was real search + generation cost for a section that doesn't need
-- to feel live-updated throughout the day.
--
-- cron.schedule() with the SAME job name ('generate-trending-topics')
-- updates the existing job in place rather than creating a second one —
-- same idiom 0003 itself used to originally create it.
select cron.schedule(
  'generate-trending-topics',
  '0 11 * * *',
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
