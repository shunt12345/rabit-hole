-- Extends the review window from 0046 to the trending/news fields too —
-- the admin wants to review those as well, and one-day-old trending picks
-- is an accepted tradeoff for being able to catch a bad one before it
-- publishes. Moves 'generate-trending-topics' (Trending 1/2/Wildcard,
-- migration 0022) from 07:00 UTC to 15:00 UTC — same time the evergreen
-- batch already moved to in 0046, so everything now generates together,
-- sits in the queue together, and is covered by 0046's 07:00 UTC
-- auto-approve-if-untouched sweep the next morning. generate-trending-
-- topics/index.ts no longer exempts NEWS_FIELDS from status='pending' —
-- every row goes through review now.
--
-- cron.schedule() upserts by job name — re-running 'generate-trending-
-- topics' with the same name and a new schedule replaces the existing
-- job (last updated in 0022) rather than creating a duplicate.
select cron.schedule(
  'generate-trending-topics',
  '0 15 * * *',
  $$
  select net.http_post(
    url := 'https://gflcioanuzrxgxxafnzl.supabase.co/functions/v1/generate-trending-topics',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 170000
  );
  $$
);
