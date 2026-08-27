-- Backs the hero page's "In the news" chips. Populated by the
-- generate-trending-topics edge function (via a scheduled pg_cron job, see
-- the next migration), never written to by the app itself — the app only
-- ever reads the latest batch with the anon key.
create table if not exists trending_topics_cache (
  id bigint generated always as identity primary key,
  batch_date date not null,
  field text not null,
  topic text not null,
  teaser text not null,
  source_url text,
  generated_at timestamptz not null default now()
);

create index if not exists trending_topics_cache_batch_date_idx
  on trending_topics_cache (batch_date desc, id asc);

alter table trending_topics_cache enable row level security;

-- Non-sensitive published content — the hero page reads this with just the
-- anon key, no auth required.
create policy "Public can read trending topics"
  on trending_topics_cache for select
  using (true);
