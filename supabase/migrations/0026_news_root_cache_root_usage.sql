-- Same idea as 0025 (article usage), but for the root's own overview/
-- children generation — a cache hit there was ALSO returning zeroed usage
-- and skipping billing entirely, even before article caching existed.
-- Populated by the CLIENT's own newsCacheWrite (see writeNewsRootCache),
-- not a server-side background update like the article columns: this row
-- is created by that same write, so there's no existing-row race to worry
-- about the way there would be updating it from a separate background task.
alter table news_root_cache add column if not exists root_input_tokens integer;
alter table news_root_cache add column if not exists root_output_tokens integer;
