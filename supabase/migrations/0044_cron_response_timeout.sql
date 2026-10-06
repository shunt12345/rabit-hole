-- pg_net's net.http_post defaults to a 5000ms response timeout, and none
-- of the three cron jobs calling it here ever overrode that -- confirmed
-- live: net._http_response for a manual generate-trending-topics trigger
-- showed "Timeout of 5000 ms reached" (DNS alone took ~170ms of that
-- budget), despite this function routinely running well past 5s (web
-- search + a Claude call per field, several fields, the news cron's
-- sequential Trending 1/2 pair). That's been true every single run since
-- these jobs were first scheduled, and the function completing and
-- inserting its results after pg_net stops listening is what's let most
-- nights still succeed -- but it also means net._http_response has never
-- recorded a REAL status code or response body for any of these calls,
-- only ever "timeout," which is a dead end for diagnosing a run that
-- genuinely does fail. Raised to comfortably clear generate-trending-
-- topics' own ~150s hard ceiling (see that function's PER_FIELD_TIMEOUT_MS
-- comment) so pg_net actually waits for and records the real outcome.
-- send-daily-digest gets the same treatment for consistency, even though
-- it's normally much faster -- cheap insurance as the recipient list
-- grows.
--
-- cron.schedule() upserts by job name -- re-running each of these with the
-- same name and a new command replaces the existing job rather than
-- creating a duplicate. Bodies are copied unchanged from their last
-- update (0042 for -special, 0022 for the plain news job, 0021 for the
-- digest) -- only timeout_milliseconds is new.
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
    body := '{}'::jsonb,
    timeout_milliseconds := 170000
  );
  $$
);

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
    body := jsonb_build_object('fields', jsonb_build_array('This Day In History', 'Word Of The Day', 'Quote Of The Day', 'Riddle', 'Perspective')),
    timeout_milliseconds := 170000
  );
  $$
);

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
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
