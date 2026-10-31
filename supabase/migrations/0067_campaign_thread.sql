-- The TikTok ad's landing page: a Hyfax thread built from the ad's own
-- cascade (Stale Bread → Chocolate Bloom → Glacier Ice → Marble), opened by
-- the ad link's ?thread=<id> and revealed step by step as the reader
-- scrolls, like any thread (src/ChainView.jsx).
--
-- status 'campaign': readable by anyone (the link has to open for every ad
-- visitor), but kept out of Spin a thread and the Hyfax of the Day
-- rotation, which only use 'approved' threads. Adding it as 'approved'
-- would also have shifted which thread is today's Hyfax of the Day, since
-- the rotation steps through the approved threads by count.
alter table hyfax_chains drop constraint if exists hyfax_chains_status_check;
alter table hyfax_chains add constraint hyfax_chains_status_check check (status in ('pending', 'approved', 'rejected', 'campaign'));

drop policy if exists "Anyone reads approved chains" on hyfax_chains;
create policy "Anyone reads approved chains" on hyfax_chains for select using (status in ('approved', 'campaign'));

insert into hyfax_chains (title, steps, status, model)
select 'Stale Bread to Marble', '[
  {"title": "Why Bread Goes Stale", "link": "", "why": "Not drying out: baking melts starch into a soft gel, and as the loaf cools it creeps back into tight crystals.", "deep": "A sealed loaf loses almost no water and still turns hard. Baking bursts the starch granules in flour into a soft, water-filled gel; as the bread cools, the long starch molecules slowly line back up into ordered crystals, squeezing the crumb firm. It runs fastest at fridge temperatures, which is why refrigerated bread stales several times faster than bread on the counter, and a few minutes in a hot oven melts the crystals back for a while."},
  {"title": "Chocolate Bloom", "link": "Same idea, new food", "kind": "indirect", "why": "The same crystal comeback, in cocoa butter instead of starch: that chalky film on old chocolate is fat re-setting in the wrong crystal.", "deep": "Cocoa butter can set into six different crystal forms, and only one of them, Form V, gives chocolate its gloss and clean snap. A warm afternoon melts some of that fat, it drifts to the surface and re-sets in a looser form that scatters light, so the bar turns dusty grey. It is still safe to eat, and melting it down resets the crystals."},
  {"title": "Glacier Ice", "link": "Same comeback, in snow", "kind": "indirect", "why": "Buried snowflakes lose their lacy arms and regrow into big, dense grains of ice: a glacier is snow recrystallized under its own weight.", "deep": "A fresh snowflake is mostly air around a delicate six-armed crystal. Buried by later snowfalls, its arms evaporate away and the grains round off and fuse into granular firn. Over years to decades the weight above squeezes out the air while the grains keep recrystallizing and growing, until the firn becomes glacier ice, with crystals that can reach several centimetres across in old ice. It is dense enough to absorb red light, which is why deep glacier ice looks blue."},
  {"title": "Marble", "link": "Same trick, in stone", "kind": "indirect", "why": "Heat and pressure deep underground make limestone''s tiny calcite grains regrow into larger interlocking crystals, and limestone becomes marble.", "deep": "Limestone is built from tiny grains of calcite, often the crushed shells of sea creatures. Buried deep and squeezed as mountains rise, it heats up without melting, and the calcite recrystallizes: small grains give way to bigger, interlocking crystals, erasing fossils and layers. The result is marble, which glitters when cut because light catches the faces of those larger crystals. The Carrara marble Michelangelo carved formed this way, from limestone laid down in an ancient sea."}
]'::jsonb, 'campaign', 'hand-written'
where not exists (select 1 from hyfax_chains where title = 'Stale Bread to Marble');

-- The id to put in the TikTok ad link (?thread=<id>).
select id, title, status from hyfax_chains where title = 'Stale Bread to Marble';
