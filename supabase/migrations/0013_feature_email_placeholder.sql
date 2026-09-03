-- Adds a placeholder toggle for the future email digest (punch list
-- Section E — not built yet; no email actually gets sent from this
-- column existing). Captured now via the same feature-toggle
-- pattern/UI as News/Today/Dig Deeper so a user's preference already
-- exists and is ready the moment Section E ships, rather than needing a
-- second onboarding moment later. Defaults on, matching migration 0012's
-- opt-out flip for the other toggles.
alter table profiles add column if not exists feature_email boolean not null default true;

-- Extend the column-level UPDATE grant from migration 0011 to cover this
-- new column — GRANT statements aren't retroactive for columns added
-- after the fact, so without this a user could read but not write their
-- own feature_email preference.
grant update (feature_email) on profiles to authenticated;
