-- Adds real token-usage columns to the Phase 1 logging table (see
-- 0001_rabbit_hole_request_logs.sql) so per-endpoint cost can be computed
-- from actual traffic instead of an estimate. Nullable because rows logged
-- before this migration — and any row where usage parsing fails — won't
-- have them; the proxy is written to fail open (still log the row, still
-- serve the real request) rather than lose a row over a parsing hiccup.
alter table rabbit_hole_request_logs
  add column if not exists input_tokens integer,
  add column if not exists output_tokens integer;
