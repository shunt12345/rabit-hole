-- Adds "Riddle" (Reverse Hyfax) to the nightly special-fields cron job (see
-- 0004_generate_trending_topics_special_cron.sql, previously extended for
-- Word Of The Day in 0017 and Quote Of The Day in 0023). cron.schedule()
-- upserts by job name — re-running it with the same name and a new command
-- replaces the existing job rather than creating a duplicate.
--
-- "options" holds the 2 decoy topics for the multiple-choice guess (see
-- riddlePrompt in generate-trending-topics/index.ts) — nullable since every
-- other field's rows never populate it, only ever the "Riddle" field's.
alter table trending_topics_cache
  add column if not exists options jsonb;

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
    body := jsonb_build_object('fields', jsonb_build_array('National Day', 'This Day In History', 'Word Of The Day', 'Quote Of The Day', 'Riddle'))
  );
  $$
);
