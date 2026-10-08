-- Marks requests from a ?hyfax_test=1 browser (the operator's own testing,
-- see lib/visitor.js) so admin-usage-stats can leave them out, the same way
-- the Adoption section already leaves out test visitors. Run before
-- redeploying rabbit-hole-proxy-v2: its log insert writes this column.
alter table rabbit_hole_request_logs
  add column if not exists is_test boolean not null default false;

-- Backfills the 2026-10-08 test traffic: the direct proxy checks (their
-- session ids) and the browser test runs, which came from the same
-- network address as those checks.
update rabbit_hole_request_logs
set is_test = true
where created_at >= '2026-10-08'
  and (
    session_id like 'phase1-%'
    or session_id like 'haiku-switch-check%'
    or ip_address in (
      select distinct ip_address
      from rabbit_hole_request_logs
      where session_id like 'phase1-%' and ip_address is not null
    )
  );
