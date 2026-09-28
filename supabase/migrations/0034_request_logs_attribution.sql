-- Ad-attribution signals, captured client-side from the URL once per
-- session (see src/lib/attribution.js) and attached to EVERY request, not
-- just the root call that happened to carry the URL params — so a whole
-- session's cost/behavior can be traced back to its source. Nullable: the
-- overwhelming majority of traffic has no UTM params at all (direct/
-- organic), and existing rows predate this column entirely.
alter table rabbit_hole_request_logs
  add column if not exists utm_source text,
  add column if not exists utm_campaign text,
  add column if not exists rdt_cid text;

create index if not exists rabbit_hole_request_logs_utm_source_idx
  on rabbit_hole_request_logs (utm_source);
