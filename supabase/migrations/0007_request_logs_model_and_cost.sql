-- Closes the rest of the Phase 1 ask from the pricing measurement build
-- spec: migration 0005 added input_tokens/output_tokens; this adds the two
-- columns still missing — model (currently always "claude-sonnet-5", but
-- worth logging explicitly so a future per-tier model choice, per Phase 2
-- of the same spec, doesn't require yet another migration) and cost_usd,
-- computed once at insert time from whatever rate was live then (see
-- SONNET_INPUT_PRICE_PER_M / SONNET_OUTPUT_PRICE_PER_M in
-- rabbit-hole-proxy/index.ts) so a later price change never retroactively
-- re-costs old rows.
alter table rabbit_hole_request_logs
  add column if not exists model text,
  add column if not exists cost_usd numeric(10, 6);
