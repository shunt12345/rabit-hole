-- Starts the hero precompute (.github/workflows/precompute-hero.yml) from
-- here, right after the 07:00 UTC hero switch, instead of relying on
-- GitHub's own schedule -- confirmed live that its 07:10 cron started at
-- 13:56, leaving that morning's hero threads uncached for seven hours.
-- GitHub's schedule stays on as a later backup (a second run is all cache
-- hits, so it costs nothing but time).
--
-- Needs a GitHub token in Vault named github_dispatch_token: a
-- fine-grained token for shunt12345/rabit-hole with "Actions: Read and
-- write". Add it once in the SQL editor (not in a migration, so it never
-- lands in the repo):
--   select vault.create_secret('<token>', 'github_dispatch_token');

create or replace function trigger_precompute_hero()
returns bigint
language sql
security definer
set search_path = public, extensions
as $$
  select net.http_post(
    url := 'https://api.github.com/repos/shunt12345/rabit-hole/actions/workflows/precompute-hero.yml/dispatches',
    headers := jsonb_build_object(
      'Accept', 'application/vnd.github+json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_dispatch_token' limit 1),
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'hyfax-precompute',
      'Content-Type', 'application/json'
    ),
    body := '{"ref":"main"}'::jsonb,
    timeout_milliseconds := 20000
  );
$$;

-- Only the cron job (and an admin in the SQL editor) should start it.
revoke all on function trigger_precompute_hero() from public, anon, authenticated;

-- Three minutes after publish_due_trending_topics() (07:00) has made the
-- new picks visible, so the run caches the new day's topics.
select cron.schedule('precompute-hero-pages', '3 7 * * *', $$ select trigger_precompute_hero(); $$);
