-- Extends news_root_cache (0008) to also cache the root's full "read more"
-- article text, not just its overview/children. Confirmed live this was
-- missing entirely: every visitor who dug into the same Trending/Today/
-- Quote root got a completely fresh, differently-worded article each time
-- — real Anthropic cost duplicated per visitor for identical content, and
-- a confusing "why did this change?" experience for anyone who revisits a
-- topic. Nullable and additive only — existing rows just have article =
-- null until the next visitor's write fills it in, same "first write wins"
-- pattern as the rest of this table.
alter table news_root_cache add column if not exists article text;
