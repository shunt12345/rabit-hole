-- Stores the real token usage from a Trending/Today/Quote root's FIRST
-- article generation (0024 added the article text itself), so a later
-- cache hit can bill that same real cost to every subsequent reader
-- instead of serving it for free. Most traffic starts from the hero page,
-- so a free ride on every cache hit after the first visitor would give
-- away real, meaningful revenue rather than just a rounding error.
alter table news_root_cache add column if not exists article_input_tokens integer;
alter table news_root_cache add column if not exists article_output_tokens integer;
