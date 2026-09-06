-- Account-level "continue exploring" history — the cross-device
-- counterpart to the browser-local version (localStorage, see
-- src/lib/exploredHistory.js). A signed-in user's explored topics live
-- here instead, so "continue exploring" follows them to a different
-- device/browser instead of staying stuck on whichever one they were on
-- when they dug in. Anonymous visitors keep using localStorage only —
-- there's no account row to attach this to until they sign in, at which
-- point the client migrates whatever local history exists into here
-- (see exploredHistory.js's migrateLocalHistoryToAccount).
--
-- Same shape and same 8-entry-per-identity cap as the local version
-- (enforced client-side after each upsert, see pruneAccountHistory) —
-- this is a small, disposable convenience cache, not something that
-- needs to grow without bound or be backed up/audited.
create table if not exists explored_topics (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  full_topic text,
  overview text not null default '',
  children jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (user_id, label)
);

create index if not exists explored_topics_user_id_updated_at_idx
  on explored_topics (user_id, updated_at desc);

alter table explored_topics enable row level security;

-- Full CRUD scoped to the caller's own rows via auth.uid() — same RLS
-- shape as profiles/billing_transactions elsewhere in this project. This
-- table only ever holds a person's own non-sensitive browsing history
-- (topic labels + short teaser text already shown to them in the app),
-- so there's no need for the tighter column-level grants profiles uses.
create policy "Users can read own explored topics" on explored_topics
  for select using (auth.uid() = user_id);

create policy "Users can insert own explored topics" on explored_topics
  for insert with check (auth.uid() = user_id);

create policy "Users can update own explored topics" on explored_topics
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users can delete own explored topics" on explored_topics
  for delete using (auth.uid() = user_id);
