-- Backs the accounts system (Production Punch List, Section A) — the first
-- real, persistent user identity this app has had. Everything before this
-- was an anonymous session_id in localStorage, which is exactly why the
-- free-tier loophole exists (see the monetization outline doc, Section
-- 14.2): clearing browser storage gets a fresh identity for free. A real
-- account is what the funded-experience plan (Section 14.1 of that doc —
-- balance, feature toggles, usage meters) has to attach to.
--
-- One row per Supabase Auth user, created automatically on signup by the
-- trigger below — never written to directly by the app on signup, so
-- there's no window where a user exists in auth.users without a matching
-- profile row.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  -- Prepaid balance (Section 14.1). Defaults to 0 — funding this is a
  -- separate build (billing/Stripe integration, punch list Section D) not
  -- part of this migration; the column exists now so accounts have
  -- somewhere for a balance to live once that ships.
  balance_usd numeric(10,2) not null default 0,
  auto_reload boolean not null default false,
  -- Feature toggles (Section 14.1's "funded users can toggle any function
  -- on/off"). Defaults to everything off / the smallest node count — the
  -- toggle UI itself is a separate build (punch list Section C); this just
  -- gives those preferences a place to persist once built.
  feature_news boolean not null default false,
  feature_today boolean not null default false,
  feature_dig_deeper boolean not null default false,
  node_count smallint not null default 3,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- A user can only ever see/change their own row — never another user's
-- balance or preferences, and no anon access at all (unlike
-- trending_topics_cache/news_root_cache, this table holds real personal +
-- financial data).
create policy "Users can read own profile"
  on profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id);

-- No insert policy for regular users — rows are only ever created by the
-- trigger below (running as security definer), never directly by client
-- code, so a user can't create a profile for an id that isn't their own or
-- pre-seed a balance for themselves.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
