-- Thread previews are free: a page counts as one of the reader's free pages
-- when it's explored, not when its preview opens. rabbit-hole-proxy-v2
-- marks a preview's log row preview = true; the free-page count skips those
-- rows, and previews get their own daily cap (PREVIEW_DAILY_LIMIT, default
-- 40). Run this BEFORE redeploying the proxy, which filters on the column.
alter table rabbit_hole_request_logs add column if not exists preview boolean not null default false;

-- Check: should list the new column.
select column_name, data_type, column_default from information_schema.columns
where table_name = 'rabbit_hole_request_logs' and column_name = 'preview';
