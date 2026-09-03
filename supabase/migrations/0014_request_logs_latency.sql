-- Adds real latency measurement to the request log, so cost/latency
-- analysis (see the SQL used to compare endpoints) can use a real number
-- instead of output-token count as a proxy for how long a call took.
alter table rabbit_hole_request_logs add column if not exists latency_ms integer;
