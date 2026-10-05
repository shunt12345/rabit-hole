-- Corrects the Stale Bread root article (migration 0039): the original
-- copy had a closing "kicker" line marked as its own small UI element, not
-- part of the article body -- folded into the article as a 4th paragraph
-- by mistake. The corrected copy drops it entirely rather than place it
-- elsewhere. Only the article text changes -- overview/children/branch
-- articles from 0039/0040 are untouched.
update news_root_cache
set article = 'Stale bread isn''t dry bread. A loaf sealed in a bag loses almost no water and still turns hard, crumbly and flat-tasting. The culprit is starch. Baking melts the orderly starch granules in flour into a soft, open gel, and the moment the loaf cools, those starch molecules start creeping back into tight crystal structures. The process is called starch retrogradation, and it''s what turns a springy crumb into cardboard.

That''s where the fridge backfires. Retrogradation runs fastest at cool, above-freezing temperatures, so a refrigerator speeds staling up instead of slowing it down. Room temperature is slower. The freezer stops it almost completely, because the molecules can''t move enough to reorganize. Hence the baker''s rule: counter for a day or two, freezer for longer, fridge never.

The good news is that it runs in reverse. A few minutes in a hot oven melts those crystals back into gel, and the loaf comes back soft, briefly, before re-staling faster the second time. And that slow creep toward crystal shows up far outside the bread box. The chalky white film on old chocolate is cocoa butter reorganizing into a different crystal form, the whole story behind Chocolate Bloom. A jar of honey turns grainy as its sugar crystallizes out, and a warm water bath rescues it the same way the oven rescues bread, explored under Crystallized Honey. Even glaciers run the same play: fallen snow slowly recrystallizes into dense blue ice over years, a whole rabbit hole waiting under Glacier Ice.'
where cache_key = 'why does bread go stale';
