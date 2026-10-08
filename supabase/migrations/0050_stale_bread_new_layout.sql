-- Moves the Reddit ad landing ("why does bread go stale", migrations
-- 0039-0041) onto the article-first layout without changing a word of its
-- copy: the one direct subtopic becomes an inline [[link]] where the text
-- already names it, and the four other threads become the "Where to next?"
-- cards (2 indirect + 2 tangent, same as a freshly generated page). Those
-- cards are `pinned` because the article names three of them in passing,
-- and a new-format article would otherwise drop chips it mentions (see
-- expandNode in App.jsx). The Starch Retrogradation node_cache row from
-- 0040 still matches, since the link's label is the same Title Case name.
update news_root_cache
set
  article = replace(article, 'called starch retrogradation,', 'called [[starch retrogradation]],'),
  children = '[{"label": "Chocolate Bloom", "teaser": "That pale chalky film on old chocolate isn''t mold — it''s fat crystals staging a quiet takeover.", "type": "indirect", "pinned": true}, {"label": "Crystallized Honey", "teaser": "Honey turning gritty in the jar isn''t spoiling — it''s sugar molecules racing to recrystallize before your eyes.", "type": "indirect", "pinned": true}, {"label": "Glacier Ice", "teaser": "Fluffy snowflakes get crushed into glassy blue glacier ice through the same recrystallizing trick, just over centuries.", "type": "tangent", "pinned": true}, {"label": "Day-Old Fried Rice", "teaser": "Leftover fried rice isn''t dangerous because it''s stale — it''s a bacterial toxin that laughs at your microwave.", "type": "tangent", "pinned": true}]'::jsonb
where cache_key = 'why does bread go stale';
