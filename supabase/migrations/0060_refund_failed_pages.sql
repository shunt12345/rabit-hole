-- A page that failed to load (Anthropic returned an error, the call threw,
-- or the stream ended without writing anything) no longer uses up a free
-- page: rabbit-hole-proxy-v2 marks its log row refunded, and the free-page
-- count skips refunded rows. Run this BEFORE redeploying the proxy, which
-- filters on the column.
alter table rabbit_hole_request_logs add column if not exists refunded boolean not null default false;

-- Check: should list the new column.
select column_name, data_type, column_default from information_schema.columns
where table_name = 'rabbit_hole_request_logs' and column_name = 'refunded';
