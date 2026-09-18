-- Pre-public-launch hardening (see rabbit-hole-proxy's existing top-of-file
-- note: "each anonymous session is capped at DAILY_REQUEST_LIMIT requests
-- per rolling 24h... the cap is per-session, not global" — an accepted
-- interim tradeoff while this was small/trusted traffic only. Going public
-- means session_id (localStorage, trivially reset) is no longer a safe
-- enough identity to hang a cost ceiling on by itself.

-- Client IP alongside the existing session_id — a harder-to-reset identity
-- for a SECOND, independent request-count ceiling (see rabbit-hole-proxy's
-- DAILY_REQUEST_LIMIT_PER_IP). Nullable: existing rows have none, and a
-- request where the platform doesn't hand back a forwarded-for header
-- still logs fine, just without this extra signal.
alter table rabbit_hole_request_logs add column if not exists ip_address text;

create index if not exists rabbit_hole_request_logs_ip_created_idx
  on rabbit_hole_request_logs (ip_address, created_at);

-- Backs the new GLOBAL daily spend cap (rabbit-hole-proxy) — every request
-- so far has protected against a runaway SESSION or IP, never against
-- many small distinct ones adding up. This is the real backstop: total
-- real Anthropic cost across ALL free/unfunded traffic in the last 24h,
-- summed server-side rather than pulling every row's cost_usd back to the
-- function just to add it up. security definer + the explicit grant below
-- means only the service-role-authenticated edge function can call this,
-- same posture as deduct_balance/credit_balance (migration 0011).
create or replace function get_recent_spend_usd(since timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(cost_usd), 0) from rabbit_hole_request_logs where created_at >= since;
$$;

grant execute on function get_recent_spend_usd(timestamptz) to service_role;
