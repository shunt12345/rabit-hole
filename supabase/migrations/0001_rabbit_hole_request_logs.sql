-- Phase 1 logging table (see handoff README): timestamp + anonymous
-- session id + endpoint label for every request that goes through the
-- rabbit-hole-proxy edge function. Exists purely so Phase 2's per-person
-- usage caps can be set from real usage data instead of a guess before
-- launch.
create table if not exists rabbit_hole_request_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  session_id text not null,
  endpoint text not null
);

create index if not exists rabbit_hole_request_logs_session_id_idx
  on rabbit_hole_request_logs (session_id);

create index if not exists rabbit_hole_request_logs_created_at_idx
  on rabbit_hole_request_logs (created_at);

-- Only the edge function (using the service role key) writes or reads this
-- table; no client-side access is needed or granted.
alter table rabbit_hole_request_logs enable row level security;
