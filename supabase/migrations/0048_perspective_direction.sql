-- Perspective-only: which way an entry shifted scale ("micro" or
-- "macro"), alongside the existing `category` column (its Human/Nature/
-- Space focus, see migration 0031). Lets the hero card's badge show
-- "Human · Micro" instead of just repeating the section header's own
-- "Perspective" label — see App.jsx's Perspective card.
alter table trending_topics_cache
  add column if not exists direction text;

alter table trending_topics_cache
  add constraint trending_topics_cache_direction_check
  check (direction is null or direction in ('micro', 'macro'));
