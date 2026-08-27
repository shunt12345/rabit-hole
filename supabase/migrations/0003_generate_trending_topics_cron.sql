-- Schedules generate-trending-topics to run twice a day. The shared secret
-- the function checks against is read from Supabase Vault by name at
-- invocation time, never stored in this file — set it up with:
--   select vault.create_secret('<a random string>', 'cron_secret');
--   supabase secrets set CRON_SECRET=<the same random string>
-- before this job's first scheduled run.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'generate-trending-topics',
  '0 8,16 * * *',
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
