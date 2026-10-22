-- A Trending pick's confirmed facts (generate-trending-topics writes 3 to
-- 5 lines from the reporting). The story's page is written from them, so
-- it can't fill in details the one-line teaser doesn't carry. Null for
-- every other field and for picks made before this.
alter table trending_topics_cache add column if not exists facts text;
