-- Phase 1 of the pricing measurement build spec asks for real token usage
-- on generate-trending-topics too, not just rabbit-hole-proxy. Each row in
-- this table already represents exactly one Claude call (one field, one
-- batch), so the usage/cost columns live directly on it rather than a
-- separate log table — no new table needed, no session_id to fabricate for
-- a backend job that has no session.
alter table trending_topics_cache
  add column if not exists input_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists model text,
  add column if not exists cost_usd numeric(10, 6);
