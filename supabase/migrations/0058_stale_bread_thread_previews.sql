-- Fits the Reddit ad landing ("why does bread go stale") to thread
-- previews: each card's description now says how that thread follows from
-- stale bread (the same lines approved in the Thread Previews demo), so the
-- article's closing half -- which pointed at the cards by name ("the whole
-- story behind Chocolate Bloom", ...) -- is cut. The paragraph keeps the
-- oven reversal and ends on the line that leads into the cards. Paragraphs
-- one and two, and the [[starch retrogradation]] link, are unchanged.
update news_root_cache
set
  article = replace(
    article,
    ' The chalky white film on old chocolate is cocoa butter reorganizing into a different crystal form, the whole story behind Chocolate Bloom. A jar of honey turns grainy as its sugar crystallizes out, and a warm water bath rescues it the same way the oven rescues bread, explored under Crystallized Honey. Even glaciers run the same play: fallen snow slowly recrystallizes into dense blue ice over years, a whole rabbit hole waiting under Glacier Ice.',
    ''
  ),
  children = '[{"label": "Chocolate Bloom", "teaser": "Stale bread''s crystal comeback, happening in cocoa butter. That chalky film isn''t mold.", "type": "indirect", "pinned": true}, {"label": "Crystallized Honey", "teaser": "Sugar recrystallizes too. It''s why the honey in your cupboard turns gritty.", "type": "indirect", "pinned": true}, {"label": "Glacier Ice", "teaser": "Staling on a geological clock: snow recrystallizes, under pressure, into dense blue ice.", "type": "tangent", "pinned": true}, {"label": "Day-Old Fried Rice", "teaser": "Old bread only loses texture. Old rice can make you sick, and reheating won''t fix it.", "type": "tangent", "pinned": true}]'::jsonb
where cache_key = 'why does bread go stale';

-- Check: the article should now end "...far outside the bread box."
select right(article, 60) as article_ending, children->0->>'teaser' as first_card from news_root_cache where cache_key = 'why does bread go stale';
