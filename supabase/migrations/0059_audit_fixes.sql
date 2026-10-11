-- Two fixes from the audit of the recent changes.

-- 1. publish_due_trending_topics() (0055) is SECURITY DEFINER but was
--    never locked down, so anyone with the anon key could call it through
--    /rest/v1/rpc and run the 07:00 sweep (deleting rejected rows) at any
--    time. Only the cron job (as postgres) needs it.
revoke execute on function publish_due_trending_topics() from public, anon, authenticated;

-- 2. The free-tier spend backstop sums logged cost, but cache hits are
--    logged with their original page's cost while costing nothing, so the
--    precompute run and every cached view pushed the free tier toward its
--    daily cap for no real spend. Only real Anthropic calls count now.
create or replace function get_recent_spend_usd(since timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(cost_usd), 0)
  from rabbit_hole_request_logs
  where created_at >= since and not coalesce(cache_hit, false);
$$;

revoke execute on function get_recent_spend_usd(timestamptz) from public, anon, authenticated;
grant execute on function get_recent_spend_usd(timestamptz) to service_role;

-- Check: both should be false.
select
  has_function_privilege('anon', 'publish_due_trending_topics()', 'execute') as anon_can_publish,
  has_function_privilege('anon', 'get_recent_spend_usd(timestamptz)', 'execute') as anon_can_read_spend;
