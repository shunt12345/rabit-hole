-- Hyfax chains: four topics on one thread, each an indirect leap from the
-- one before ("Stale Bread to Samurai Sword"). Spin a thread puts a chain's
-- title in the homepage search box and Dig in opens it (src/ChainView.jsx).
-- Written once a day in a batch by generate-hyfax-chains, which also
-- fact-checks each one, so a spin is instant and costs nothing.
--
-- steps: [{title, link, why, deep}] x 4 (link is "" for the first step).
-- Anyone can read approved chains; only the service role writes.
create table if not exists hyfax_chains (
  id bigint generated always as identity primary key,
  title text not null,
  steps jsonb not null,
  status text not null default 'approved' check (status in ('approved', 'rejected')),
  model text,
  cost_usd numeric,
  created_at timestamptz not null default now()
);
create index if not exists hyfax_chains_created_at_idx on hyfax_chains (created_at desc);

alter table hyfax_chains enable row level security;
drop policy if exists "Anyone reads approved chains" on hyfax_chains;
create policy "Anyone reads approved chains" on hyfax_chains for select using (status = 'approved');

-- The first chain, hand-written, so Spin has one before the first batch.
insert into hyfax_chains (title, steps, model)
select 'Stale Bread to Samurai Sword', '[
  {"title": "Why Bread Goes Stale", "link": "", "why": "Not drying out: baking melts starch into a soft gel, and as the loaf cools it creeps back into tight crystals.", "deep": "A sealed loaf loses almost no water and still turns hard. Baking bursts the starch granules in flour into a soft, water-filled gel; as the bread cools, the long starch molecules slowly line back up into ordered crystals, squeezing the crumb firm. It runs fastest at fridge temperatures, which is why refrigerated bread stales several times faster than bread on the counter, and a few minutes in a hot oven melts the crystals back for a while."},
  {"title": "Chocolate Bloom", "link": "Same idea, new food", "why": "The same crystal comeback, in cocoa butter instead of starch: that chalky film on old chocolate is fat re-setting in the wrong crystal.", "deep": "Cocoa butter can set into six different crystal forms, and only one of them, Form V, gives chocolate its gloss and clean snap. A warm afternoon melts some of that fat, it drifts to the surface and re-sets in a looser form that scatters light, so the bar turns dusty grey. It is still safe to eat, and melting it down resets the crystals."},
  {"title": "Tempering Steel", "link": "Same word, new material", "why": "Chocolatiers and blacksmiths both temper: they heat and cool on purpose to choose which crystals form, one for snap, one for toughness.", "deep": "Quenching red-hot steel in water locks its iron and carbon into martensite, a crystal structure that is very hard but brittle. Tempering reheats it to a few hundred degrees, letting some of that strain relax into a tougher structure. Smiths once judged the temperature by the colour of the oxide film on the metal, from pale straw to blue, each shade a different balance of hardness and toughness."},
  {"title": "The Katana''s Wavy Line", "link": "Same trick, one blade", "why": "Swordsmiths coat the spine in clay so the edge cools fast and hard, the back slow and flexible: two crystal structures in one blade, visible as the wave.", "deep": "Before quenching, a Japanese smith paints the blade with a clay mixture, thick along the spine and thin at the edge. In the water the thinly coated edge cools fast and turns to hard martensite, while the insulated spine cools slowly into softer, springier steel. The boundary between them shows after polishing as the hamon, the wavy line, and the uneven shrinking is also what gives the katana its curve."}
]'::jsonb, 'hand-written'
where not exists (select 1 from hyfax_chains where title = 'Stale Bread to Samurai Sword');

-- Daily, ahead of the 15:00 UTC picks. Same cron secret and key pattern as
-- send-daily-digest (0021) and the generous timeout from 0044.
select cron.schedule(
  'generate-hyfax-chains',
  '40 14 * * *',
  $$
  select net.http_post(
    url := 'https://gflcioanuzrxgxxafnzl.supabase.co/functions/v1/generate-hyfax-chains',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_jBvdkmRyqjTStx85VNXikw_4ocLNZRf',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 170000
  );
  $$
);
