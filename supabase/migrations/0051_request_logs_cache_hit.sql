-- Marks requests served from news_root_cache/node_cache. They're still
-- billed like a fresh generation, but the proxy no longer counts them
-- against the free daily page limit (rabbit-hole-proxy-v2's countSearches
-- filters on this). Run before redeploying the proxy: its log insert
-- writes this column.
alter table rabbit_hole_request_logs
  add column if not exists cache_hit boolean not null default false;
