-- Fixes a real bug in 0029: get_recent_spend_usd was granted to
-- service_role but Postgres's default PUBLIC execute grant on a new
-- function was never revoked, so it stayed callable by anon/authenticated
-- underneath that grant — confirmed live, a plain anon-key RPC call
-- returned the real spend figure. deduct_balance/credit_balance (migration
-- 0011) already established the correct pattern for this exact situation
-- (explicit revoke from public/anon/authenticated, THEN grant to
-- service_role) — 0029 should have followed it and didn't.
revoke execute on function get_recent_spend_usd(timestamptz) from public, anon, authenticated;
grant execute on function get_recent_spend_usd(timestamptz) to service_role;
