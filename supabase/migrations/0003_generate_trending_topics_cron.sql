-- Schedules generate-trending-topics to run twice a day. The shared secret
-- the function checks against is read from Supabase Vault by name at
-- invocation time, never stored in this file — set it up with:
--   select vault.create_secret('<a random string>', 'cron_secret');
--   supabase secrets set CRON_SECRET=<the same random string>
-- before this job's first scheduled run.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- 11:00 and 01:00 UTC = ~7am and ~9pm US Eastern (currently EDT, UTC-4) —
-- calibrated for one specific user for now, not per-visitor timezone yet.
-- EDT/EST flips twice a year (~mid-March, ~early November); pg_cron runs
-- on fixed UTC and won't follow that automatically, so this needs a
-- manual ±1 hour nudge (cron.alter_job) at each DST transition until this
-- is done properly per-visitor.
select cron.schedule(
  'generate-trending-topics',
  '0 11,1 * * *',
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
