-- Backs Section B of the production punch list (free-tier enforcement).
-- The free-trial gate needs to count a signed-in user's searches against
-- their real account, not just their current browser's session_id (which
-- resets on a cleared localStorage — an accepted trade-off for anonymous
-- visitors per the monetization outline's Section 14.2, but a real
-- account should count against something a sign-out/sign-in can't reset).
-- Nullable: most rows are still anonymous and have no user_id, exactly
-- like today.
alter table rabbit_hole_request_logs
  add column if not exists user_id uuid references auth.users(id);

create index if not exists rabbit_hole_request_logs_user_id_idx
  on rabbit_hole_request_logs (user_id, endpoint, created_at desc);
