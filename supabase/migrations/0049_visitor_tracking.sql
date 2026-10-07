-- Anonymous visitor/session/event tracking for /admin's new "Adoption"
-- section (activation, depth, retention). Three tables, same posture as
-- rabbit_hole_request_logs (migration 0001): RLS enabled, no policies at
-- all, so only the service role (used inside edge functions) can read or
-- write any of this — never queryable with the anon key, even though the
-- data itself is anonymous (no name/email/raw IP stored here).
--
-- visitors: one row per browser (see src/lib/visitor.js's hyfax_vid,
-- localStorage, persists across visits/days by design). First-touch
-- attribution only — first_source/first_campaign/first_content are set
-- once, on that visitor's very first event, and never overwritten by a
-- later visit's different UTMs (unlike lib/attribution.js's own
-- sessionStorage snapshot, which is latest-touch per session and stays
-- that way for the session-scoped API-attribution use case it already
-- serves). user_id links once an anonymous visitor signs up or signs in —
-- see track-event's own opportunistic linking, which runs on every event
-- made while signed in, covering both a brand-new signup and a returning
-- user on a new device the same way.
create table if not exists visitors (
  visitor_id uuid primary key,
  first_seen_at timestamptz not null default now(),
  first_source text,
  first_campaign text,
  first_content text,
  user_id uuid references auth.users(id) on delete set null,
  is_test boolean not null default false
);

create index if not exists visitors_user_id_idx on visitors (user_id);
create index if not exists visitors_first_seen_at_idx on visitors (first_seen_at);

alter table visitors enable row level security;

-- sessions: a run of activity with no gap longer than 30 minutes (see
-- visitor.js). utm_* here is that SESSION's own attribution snapshot —
-- deliberately separate from visitors.first_* (which never changes) and
-- from attribution.js's sessionStorage copy (which is about API request
-- tagging, not this table) — a visitor can return across many sessions
-- under different campaigns, and each session's own entry point matters
-- for the funnel/campaign filtering in the Adoption section.
create table if not exists sessions (
  session_id uuid primary key,
  visitor_id uuid not null references visitors(visitor_id) on delete cascade,
  started_at timestamptz not null default now(),
  utm_source text,
  utm_campaign text,
  utm_content text,
  rdt_cid text
);

create index if not exists sessions_visitor_id_idx on sessions (visitor_id);
create index if not exists sessions_started_at_idx on sessions (started_at);

alter table sessions enable row level security;

-- events: land (first page view of a session), tap (a chip/link/explore-
-- next that opens a new page), article_view (any article page view,
-- cached or freshly generated), signup (account created — detected
-- client-side the same way lib/redditPixel.js's maybeReportSignUp
-- already does: auth.users' created_at and last_sign_in_at within 60s of
-- each other, the same heuristic this codebase already trusts for
-- Reddit's own signup conversion tracking).
create table if not exists events (
  id bigint generated always as identity primary key,
  visitor_id uuid not null references visitors(visitor_id) on delete cascade,
  session_id uuid not null references sessions(session_id) on delete cascade,
  type text not null check (type in ('land', 'tap', 'article_view', 'signup')),
  page text,
  created_at timestamptz not null default now()
);

create index if not exists events_visitor_id_idx on events (visitor_id);
create index if not exists events_session_id_idx on events (session_id);
create index if not exists events_type_created_at_idx on events (type, created_at);

alter table events enable row level security;
