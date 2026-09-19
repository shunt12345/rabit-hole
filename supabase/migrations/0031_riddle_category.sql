-- Tracks which broad category each Riddle answer fell into (animal,
-- place, invention, etc.) — nullable, only ever populated for the
-- "Riddle" field's rows. Confirmed live: the riddle kept defaulting to
-- animals (octopus cognition, immortal jellyfish, tardigrades...) with no
-- variety, and a stateless per-call prompt has no way to know it's about
-- to pick the same kind of thing a 4th time in a row without something
-- concrete to check itself against. This column is that memory — see
-- fetchRecentRiddleCategories/riddlePrompt in generate-trending-topics.
alter table trending_topics_cache add column if not exists category text;
