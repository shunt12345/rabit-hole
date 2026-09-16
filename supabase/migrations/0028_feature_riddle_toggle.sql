-- Dedicated à la carte toggle for "Riddle me this...." (see App.jsx's
-- RIDDLE_FIELD card) — it previously reused the "Today" toggle
-- (todayVisible) as a shortcut since it launched alongside that reorder,
-- but a funded user should be able to turn it off independently, same as
-- Trending/Today/Dig Deeper: it's a real billable feature (a correct guess
-- launches a full Dig In, same cost as any other card) and "Dig In is
-- always on. Off features stop drawing on your balance." should apply to
-- it too. Defaults to true, matching every other toggle since 0012 (opt-out
-- posture, not opt-in).
alter table profiles add column if not exists feature_riddle boolean not null default true;

-- Extends the column-level UPDATE grant from migration 0011/0013 — without
-- this, updateFeatureToggles's patch would silently fail to persist this
-- one column (Supabase's default privileges only grant whole-row access,
-- which 0011 deliberately narrowed away).
grant update (feature_riddle) on profiles to authenticated;
