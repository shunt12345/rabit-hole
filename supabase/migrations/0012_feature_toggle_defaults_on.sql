-- Flips Section C's feature-toggle defaults for funded accounts from
-- opt-in to opt-out. Migration 0009 shipped feature_news/feature_today/
-- feature_dig_deeper defaulting to false, reading "the user directly
-- controls their own feature mix" (monetization outline doc, Section
-- 14.1) as "starts minimal, add what you want." Live-testing a real
-- funded account showed this reads as broken instead: the moment funded
-- status syncs client-side, News/Today/Dig Deeper vanish with no
-- explanation, right after paying. Flipped to the opposite default: a
-- funded account gets the full experience automatically, and trims
-- what it doesn't want in Manage.
alter table profiles alter column feature_news set default true;
alter table profiles alter column feature_today set default true;
alter table profiles alter column feature_dig_deeper set default true;

-- Backfill existing rows to the new default. Safe as a blanket update
-- right now — there is no real user base yet, only the developer's own
-- test account, which is currently off from the bug this migration
-- fixes, not from a deliberate choice. Do NOT re-run this kind of
-- blanket update once real funded users exist and may have genuinely
-- chosen to turn a feature off; at that point this stops being a safe
-- one-time backfill and becomes silently overwriting real preferences.
update profiles set feature_news = true, feature_today = true, feature_dig_deeper = true;
