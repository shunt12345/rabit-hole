-- Adds "Perspective" to the nightly special-fields cron job (see
-- 0004_generate_trending_topics_special_cron.sql, extended for Word Of The
-- Day in 0017, Quote Of The Day in 0023, Riddle in 0027, and with National
-- Day removed in 0038). Same once-nightly cadence as the rest of this job —
-- Perspective isn't tied to a calendar date, but it rotates through a fixed
-- 3-item focus sequence (Human/Nature/Space, see nextPerspectiveFocus in
-- generate-trending-topics/index.ts) that only advances once a run, same
-- reasoning as Word Of The Day/Quote Of The Day/Riddle already being here.
-- cron.schedule() upserts by job name — re-running it with the same name
-- and a new command replaces the existing job rather than creating a
-- duplicate.
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
    body := jsonb_build_object('fields', jsonb_build_array('This Day In History', 'Word Of The Day', 'Quote Of The Day', 'Riddle', 'Perspective'))
  );
  $$
);
