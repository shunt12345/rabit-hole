-- Reddit ad campaign content: replaces the "why do cats purr" pinned
-- landing (see migrations 0035/0036 + App.jsx's Reddit-ad-landing effect)
-- with "Why Bread Goes Stale." Same mechanism, new topic: the Reddit ad's
-- destination URL doesn't change (no ?q= param — it relies on App.jsx's
-- hardcoded default, swapped in the same commit as this migration), so
-- this overwrites what that URL lands on rather than standing up a second
-- campaign. Old "why do cats purr" rows are left in place as harmless
-- history, same posture as National Day's removal (migration 0038).
--
-- Root content is hand-authored (not a live Claude generation) for the
-- article itself; the 3 branch articles below and all 5 teasers were
-- generated live through rabbit-hole-proxy-v2 in Hyfax's real voice, then
-- reviewed before being committed here as static cached content.
insert into trending_topics_cache (batch_date, field, topic, teaser, source_url)
values (current_date, 'Starter Question', 'why does bread go stale', 'The actual molecular crime scene — how starch molecules lock arms back into crystals and turn bread to cardboard.', null);

insert into news_root_cache (cache_key, root_label, overview, children, article)
values (
  'why does bread go stale',
  'Why Bread Goes Stale',
  'Stale bread isn''t dried out — it''s starch quietly recrystallizing back into the tight structure baking melted away. And the fridge, of all appliances, makes it worse, not better.',
  '[{"label": "Chocolate Bloom", "teaser": "That pale chalky film on old chocolate isn''t mold \u2014 it''s fat crystals staging a quiet takeover.", "type": "indirect"}, {"label": "Crystallized Honey", "teaser": "Honey turning gritty in the jar isn''t spoiling \u2014 it''s sugar molecules racing to recrystallize before your eyes.", "type": "indirect"}, {"label": "Glacier Ice", "teaser": "Fluffy snowflakes get crushed into glassy blue glacier ice through the same recrystallizing trick, just over centuries.", "type": "tangent"}, {"label": "Starch Retrogradation", "teaser": "The actual molecular crime scene \u2014 how starch molecules lock arms back into crystals and turn bread to cardboard.", "type": "direct"}, {"label": "Day-Old Fried Rice", "teaser": "Leftover fried rice isn''t dangerous because it''s stale \u2014 it''s a bacterial toxin that laughs at your microwave.", "type": "tangent"}]'::jsonb,
  'Stale bread isn''t dry bread. A loaf sealed in a bag loses almost no water and still turns hard, crumbly and flat-tasting. The culprit is starch. Baking melts the orderly starch granules in flour into a soft, open gel, and the moment the loaf cools, those starch molecules start creeping back into tight crystal structures. The process is called starch retrogradation, and it''s what turns a springy crumb into cardboard.

That''s where the fridge backfires. Retrogradation runs fastest at cool, above-freezing temperatures, so a refrigerator speeds staling up instead of slowing it down. Room temperature is slower. The freezer stops it almost completely, because the molecules can''t move enough to reorganize. Hence the baker''s rule: counter for a day or two, freezer for longer, fridge never.

The good news is that it runs in reverse. A few minutes in a hot oven melts those crystals back into gel, and the loaf comes back soft, briefly, before re-staling faster the second time. And that slow creep toward crystal shows up far outside the bread box. The chalky white film on old chocolate is cocoa butter reorganizing into a different crystal form, the whole story behind Chocolate Bloom. A jar of honey turns grainy as its sugar crystallizes out, and a warm water bath rescues it the same way the oven rescues bread, explored under Crystallized Honey. Even glaciers run the same play: fallen snow slowly recrystallizes into dense blue ice over years, a whole rabbit hole waiting under Glacier Ice.

Bread, chocolate, honey, glaciers. One idea, four places. Now you''ll notice it everywhere.'
);

insert into node_cache (cache_key, root_cache_key, child_label, article)
values
  ('why does bread go stale::Chocolate Bloom', 'why does bread go stale', 'Chocolate Bloom', 'Somebody opens a chocolate bar after it''s spent a summer in a hot car and finds the whole thing coated in a dusty gray-white film, and the instant reaction is always the same — this has gone bad, throw it out. Except it hasn''t spoiled at all, not in the mold-and-bacteria sense anyone fears. That ghostly bloom is cocoa butter, the fat that gives chocolate its snap and sheen, abandoning its happy crystal structure and reforming into a different, lazier one right on the surface.

Cocoa butter is a diva of a fat — it can crystallize into six distinct structural forms, and chocolatiers obsess over locking it into exactly one of them, called Form V, through a precise heating-and-cooling dance called tempering. That form packs tightly, reflects light evenly, and gives chocolate its glossy finish and crisp break. But warm it up even slightly, let it melt a little and refreeze, and the fat molecules migrate toward the surface and resettle into Form VI — bigger, looser crystals that scatter light instead of reflecting it, which is exactly why bloomed chocolate looks pale and feels sandy instead of silky. The flavor molecules haven''t changed a bit — it''s purely a structural glow-up gone sideways, cocoa butter just finding a comfier, uglier way to sit.'),
  ('why does bread go stale::Crystallized Honey', 'why does bread go stale', 'Crystallized Honey', 'Honey is basically a sugar solution so aggressively oversaturated that it''s one temperature dip away from falling apart into crystals, and almost every jar is quietly plotting to do exactly that. Glucose, one of honey''s two main sugars, simply cannot stay dissolved forever in the tiny amount of water honey contains — it''s crammed in there at concentrations way past what water could normally hold, so eventually molecules start finding each other and locking into tight little crystal lattices, turning smooth liquid gold into something closer to sugary sand.

The ratio of glucose to fructose is basically the plot driver here — fructose stays dissolved far more easily than glucose, so honeys loaded with glucose, like clover or dandelion honey, crystallize fast, sometimes within weeks, while fructose-heavy honeys like tupelo can stay syrupy for years. Temperature matters enormously too, since crystallization kicks into high gear in that cool-but-not-cold zone around 50 to 59 degrees Fahrenheit, which is exactly why a jar in the back of a cool pantry turns grainy while one kept warm or genuinely cold stays smooth. None of it means spoilage — a gentle warm water bath melts those crystals right back into silky liquid, no harm done, no sugar lost, just a temporary structural detour.'),
  ('why does bread go stale::Glacier Ice', 'why does bread go stale', 'Glacier Ice', 'A single snowflake is one of the most delicate, airy things nature makes — six spindly arms, mostly empty space, built from ice crystals trapping huge pockets of air. Bury that same snowflake under decades of more snow, though, and something almost brutal happens to it: the elegant crystal gets crushed, broken, and forced to recrystallize into something denser, heavier, and far less photogenic, over and over, year after year.

That transformation runs through a whole cast of intermediate characters before anything resembles a glacier. Fresh snow compacts into granular firn, a sugary, porous in-between stage, as the weight above squeezes out air and pressure melts and refreezes crystal boundaries into fewer, bigger grains. Keep piling on centuries of snowfall and firn eventually seals its remaining air into isolated bubbles and recrystallizes into solid glacial ice, dense enough that light can''t easily scatter back out — it absorbs the red end of the spectrum and lets blue escape, which is the actual reason old glacier ice glows that impossible deep blue. Every one of those bubbles is a sealed time capsule of ancient atmosphere, meaning scientists can drill a core and read ice that finished recrystallizing before the pyramids existed.');
