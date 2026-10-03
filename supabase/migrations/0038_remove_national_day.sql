-- Removes "National Day" from the nightly special-fields cron job (see
-- 0004_generate_trending_topics_special_cron.sql, extended for Word Of The
-- Day in 0017, Quote Of The Day in 0023, and Riddle in 0027). Dropped as
-- redundant with "This Day In History" — both draw from the same "what's
-- notable about this date" well, and the two had already been observed
-- converging on the exact same real-world fact in a single run (see
-- generate-trending-topics/index.ts). cron.schedule() upserts by job name
-- — re-running it with the same name and a new command replaces the
-- existing job rather than creating a duplicate.
--
-- Existing "National Day" rows in trending_topics_cache are left as-is —
-- harmless history, not read by anything once the field stops being
-- requested (App.jsx's SPECIAL_FIELDS no longer lists it, so
-- latestByField never looks it up).
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
    body := jsonb_build_object('fields', jsonb_build_array('This Day In History', 'Word Of The Day', 'Quote Of The Day', 'Riddle'))
  );
  $$
);
