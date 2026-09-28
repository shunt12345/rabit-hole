-- Seeds a fixed set of "starter question" rows into trending_topics_cache
-- so the EXISTING news-cache mechanism (news_root_cache, see
-- handleNewsCacheWrite in rabbit-hole-proxy-v2) can be used for them
-- as-is, with no new server code: that write path only succeeds when the
-- cache key matches a REAL row in trending_topics_cache (a deliberate
-- security check — it's what stops any arbitrary freeform topic from
-- being cache-poisoned by a client). Field name "Starter Question" is
-- distinct from every field generate-trending-topics' cron manages
-- (NEWS_FIELDS/SPECIAL_FIELDS/QUOTE_FIELD/RIDDLE_FIELD), so this is a
-- one-time manual seed the cron will never touch, regenerate, or exclude
-- against.
--
-- These rows are NOT read via the normal latestByField/trendingTopics
-- hero-page query path (see App.jsx's STARTER_QUESTIONS constant, which
-- hardcodes the same topic strings directly) — they exist purely to
-- satisfy handleNewsCacheWrite's existence check, so a precompute script
-- can populate news_root_cache for each one ahead of any real visitor,
-- and the "why do cats purr" chip a Reddit ad links straight to renders
-- instantly instead of waiting out a fresh ~9s generation.
-- Plain insert, no ON CONFLICT — this table has no unique constraint on
-- (field, topic) to target (only the auto-generated id), so a real
-- migration runner applying this file exactly once (the normal case) is
-- what actually prevents duplicates, not a conflict clause with nothing
-- to catch.
insert into trending_topics_cache (batch_date, field, topic, teaser, source_url)
values
  (current_date, 'Starter Question', 'why do cats purr', 'A low hum that might double as a bone-healing frequency.', null),
  (current_date, 'Starter Question', 'why do we dream', 'Your brain runs a nightly simulation nobody fully understands yet.', null),
  (current_date, 'Starter Question', 'why is the sky blue', 'Sunlight gets ambushed by the air itself before it reaches your eyes.', null),
  (current_date, 'Starter Question', 'why do we get goosebumps', 'A shiver left over from fur you stopped growing thousands of years ago.', null),
  (current_date, 'Starter Question', 'why do we yawn', 'Contagious across species, and still not fully explained.', null);
