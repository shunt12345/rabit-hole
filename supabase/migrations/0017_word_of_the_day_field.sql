-- Adds "Word Of The Day" to the nightly special-fields cron job (see
-- 0004_generate_trending_topics_special_cron.sql). cron.schedule() upserts
-- by job name — re-running it with the same name and a new command
-- replaces the existing job rather than creating a duplicate, so this is
-- the whole change; no unschedule step needed.
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
    body := jsonb_build_object('fields', jsonb_build_array('National Day', 'This Day In History', 'Word Of The Day'))
  );
  $$
);
