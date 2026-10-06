-- Records why a field failed/was skipped during a generate-trending-topics
-- run — confirmed needed live, twice now: Trending 1 and then Riddle each
-- silently produced no row for a given day (Promise.allSettled tolerates a
-- single field failing, by design — see that function's top-of-file
-- comment), with no way afterward to tell whether that was an
-- exclude-history fetch failure, a rejected exact-duplicate pick, a bad
-- Anthropic response, or something else. The real reason only ever lived
-- in Supabase's function logs, reachable solely through the dashboard —
-- this makes it queryable the same way every other piece of this app's
-- data already is, with the anon key, no dashboard trip required.
create table if not exists generation_error_log (
  id bigint generated always as identity primary key,
  batch_date date not null,
  field text not null,
  error_message text not null,
  created_at timestamptz not null default now()
);

create index if not exists generation_error_log_created_at_idx
  on generation_error_log (created_at desc);

alter table generation_error_log enable row level security;

-- Same posture as trending_topics_cache: non-sensitive diagnostic text
-- (an error message, not user data), public read with just the anon key.
-- Only the edge function's service role key ever writes here.
create policy "Public can read generation error log"
  on generation_error_log for select
  using (true);
