-- Caches the generated root response (rootLabel/overview/children) for a
-- topic that came from the "In the news" or "Today" hero cards. Unlike a
-- freely typed topic, these are already identical for every visitor until
-- the next generate-trending-topics cron refresh — so the FIRST person to
-- open a given news/today card triggers the real Claude call and writes it
-- here; every other person who opens the same card (there can be hundreds,
-- clicking the same handful of cards) reads this instead of triggering
-- another full generation. cache_key is the exact topic string from
-- trending_topics_cache, which the cron job already guarantees is unique
-- per real-world story/observance (it explicitly excludes recently-shown
-- topics when generating a new one).
--
-- Written only by rabbit-hole-proxy using the service role key — never by
-- the client directly, so there's no anon write policy here, same
-- read-only-for-anon shape as trending_topics_cache.
create table if not exists news_root_cache (
  id bigint generated always as identity primary key,
  cache_key text not null unique,
  root_label text not null,
  overview text not null,
  children jsonb not null,
  created_at timestamptz not null default now()
);

alter table news_root_cache enable row level security;

-- Non-sensitive published content — read with just the anon key, no auth
-- required. No insert/update/delete policy: only the proxy's service role
-- key (which bypasses RLS entirely) ever writes here.
create policy "Public can read cached news roots"
  on news_root_cache for select
  using (true);
