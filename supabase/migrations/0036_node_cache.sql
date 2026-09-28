-- One level deeper than news_root_cache: caches a BRANCH node's own
-- children (its "dig deeper" expansion) and/or its own article, for a
-- child that sits directly under an already-cached root (see
-- news_root_cache — Trending/Today/Quote/Riddle/Starter-Question topics).
--
-- Confirmed live that this gap mattered for the Reddit ad campaign: the
-- root ("why do cats purr") was cached, but every visitor who tapped into
-- one of its 6 branch chips still triggered a fresh, uncached ~9s
-- generation each time — the ad's creative literally shows chips branching
-- out, so that's exactly where most real traffic was headed uncached.
--
-- Scoped to exactly one level deep on purpose (a branch's OWN further
-- children, two clicks from the root, stay fresh/uncached as before) —
-- that's as deep as a Reddit visitor's first click can reach, and caching
-- every possible path beyond that would multiply combinatorially for very
-- little benefit.
--
-- cache_key is "<root's cache_key>::<child label>" — see
-- rabbit-hole-proxy-v2's parseNodeCacheKey. root_cache_key/child_label are
-- broken out as their own columns (rather than only living inside
-- cache_key) so a lookup/audit can filter by root without string-parsing.
--
-- children and article are independent, nullable columns rather than two
-- separate tables — a branch's "dig deeper" expansion and its "read more"
-- article are requested independently (a visitor might open one without
-- the other), and news_root_cache already established this same
-- both-in-one-row shape for root+article.
create table if not exists node_cache (
  cache_key text primary key,
  root_cache_key text not null,
  child_label text not null,
  children jsonb,
  children_input_tokens integer,
  children_output_tokens integer,
  article text,
  article_input_tokens integer,
  article_output_tokens integer,
  created_at timestamptz not null default now()
);

create index if not exists node_cache_root_cache_key_idx on node_cache (root_cache_key);

alter table node_cache enable row level security;

-- Same read-only-for-anon shape as news_root_cache: non-sensitive published
-- content, no auth required to read. No insert/update/delete policy — only
-- rabbit-hole-proxy-v2's service role key (which bypasses RLS) ever writes
-- here, and even that path re-validates the (root, child) pairing against
-- news_root_cache before writing (see handleNodeCacheWrite) so a client
-- can't poison the cache with an arbitrary label.
create policy "Public can read cached node branches"
  on node_cache for select
  using (true);
