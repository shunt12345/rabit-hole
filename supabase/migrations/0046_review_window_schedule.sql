-- Gives the admin a real review window instead of a hard pending-forever
-- gate: moves the evergreen/date-anchored batch's generation from 07:00
-- UTC to 15:00 UTC (~11am EDT / ~10am EST -- picked specifically because
-- it lands before noon in both EST and EDT, unlike this project's other
-- fixed-UTC crons, which need a manual nudge at each DST changeover -- see
-- 0003/0021's comments), then adds a THIRD cron job that auto-approves
-- anything still sitting status='pending' at 07:00 UTC (~3am EDT / ~2am
-- EST) the next morning -- the exact slot generation used to run at.
-- Review is now optional, not blocking: the admin can approve/reject
-- anytime in that ~16-hour window at /admin, but if they don't get to it,
-- fresh content still reaches the public hero page and the 09:00 UTC
-- digest (unchanged, see 0021/0022) rather than those falling back to
-- stale, already-approved content indefinitely.
--
-- NEWS_FIELDS (Trending 1/2/Wildcard) is unaffected -- see generate-
-- trending-topics/index.ts's `needsReview` check, which exempts it from
-- status='pending' entirely. Its own cron job (migration 0022, still
-- 'generate-trending-topics', still 07:00 UTC, still a plain `{}` body)
-- isn't touched by this migration at all.
--
-- cron.schedule() upserts by job name -- re-running 'generate-trending-
-- topics-special' with the same name and a new schedule/command replaces
-- the existing job (last updated in 0042) rather than creating a
-- duplicate.
select cron.schedule(
  'generate-trending-topics-special',
  '0 15 * * *',
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
  'auto-approve-pending-trending-topics',
  '0 7 * * *',
  $$
  update trending_topics_cache set status = 'approved' where status = 'pending';
  $$
);
