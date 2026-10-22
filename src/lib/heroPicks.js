// The hero page's daily picks: where they're read from, the field each card
// shows, and how the live pick per field is chosen. The page's sections are
// in HeroSections.jsx.

// Real live topics now — see supabase/functions/generate-trending-topics.
// A scheduled job (pg_cron, twice daily) does one Claude web-search call per
// field — 2 mainstream-trending picks, plus date-anchored/evergreen fields
// ("This Day In History", "Word Of The Day") — and caches each result in
// trending_topics_cache; this just reads a batch of recent rows with the
// anon key. No live search happens on the client or per page load.
// NEWS_FIELDS / SPECIAL_FIELDS below pick the latest row per named field
// out of that batch, so a field that's been renamed or retired (like the
// old "World News"/"Science"/"Technology" beats this replaced, or the
// "Trending Wildcard" offbeat pick) just stops rendering on its own instead
// of lingering until its rows age out.
// status=eq.approved is belt-and-suspenders, not the real enforcement —
// RLS itself only allows reading approved rows now (migration 0045), so a
// pending/rejected row is unreadable with the anon key regardless of this
// query string. Kept explicit anyway so this file's own intent reads
// clearly without having to know the DB-side policy exists.
export const TRENDING_TOPICS_URL = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/trending_topics_cache?select=id,field,topic,teaser,source_url,options,category,direction,generated_at,riddle_game,publish_at,facts&status=eq.approved&order=generated_at.desc,id.desc&limit=40`;
export const NEWS_FIELDS = ["Trending 1", "Trending 2"];
// What a Trending story's page is written from: its teaser, plus the facts
// the reporting confirmed (migration 0064), so the page can't invent
// details. Older picks have no facts and pass the teaser alone.
export function storyContext(pick) {
  return pick.facts ? `${pick.teaser}\n\nWhat the reporting confirms:\n${pick.facts}` : pick.teaser;
}
// What each internal field key actually displays as — kept separate from
// the field key itself so latestByField (below) can still tell the two
// mainstream picks apart for lookup purposes while both show the same
// "Trending" badge on screen; a field with no entry here just falls back
// to showing its raw key.
export const NEWS_FIELD_LABELS = { "Trending 1": "Trending", "Trending 2": "Trending" };
export const SPECIAL_FIELDS = ["This Day In History", "Word Of The Day"];
// Same source table/cron cadence as SPECIAL_FIELDS (see promptForField in
// generate-trending-topics), but rendered as its own dedicated section
// above "Trending" instead of grouped into "Today" — deliberately kept OUT
// of SPECIAL_FIELDS above so it doesn't also show up a second time in that
// list.
export const QUOTE_FIELD = "Quote Of The Day";
// "Reverse Hyfax" — a withheld-register riddle describing a topic without
// naming it, plus a multiple-choice guess (the real topic + 2 decoys from
// `options`). Same source table/cadence as SPECIAL_FIELDS but kept out of
// that list for the same reason QUOTE_FIELD is: it needs its own card
// treatment (the guess UI), not the plain topic+teaser list layout.
export const RIDDLE_FIELD = "Riddle";
// Reframes something by shifting scale (zoom into the microscopic/
// molecular, or out to the planetary/cosmic) rather than searching for
// what's currently interesting — same source table/cadence as
// SPECIAL_FIELDS, but kept out of that list for the same reason
// QUOTE_FIELD/RIDDLE_FIELD are: its own dedicated card, placed right after
// "Today" rather than grouped into that list (see
// supabase/functions/generate-trending-topics' perspectivePrompt/
// nextPerspectiveFocus for the Human/Nature/Space rotation this reads).
export const PERSPECTIVE_FIELD = "Perspective";

// How old a row can be before it's treated as stale rather than shown as
// today's pick — generous past the ~24h cron cadence (36h) to tolerate
// normal timing jitter, but still short enough to catch a genuinely failed
// run. Confirmed live this matters: generate-trending-topics silently
// failed for one field one day (no error surfaced anywhere a visitor could
// see), and with no staleness check at all, the PREVIOUS day's row for
// that field just kept showing indefinitely as if it were current —
// exactly the kind of thing "Trending" can't afford to get wrong.
const MAX_STALE_HOURS = 36;
// When a pick went public: its scheduled publish time (migration 0053),
// or its generation time for rows from before that existed.
export function liveSince(row) {
  return new Date(row.publish_at || row.generated_at).getTime();
}
export function isFresh(row) {
  return Date.now() - liveSince(row) <= MAX_STALE_HOURS * 60 * 60 * 1000;
}

// The "as of" badge's actual date — the max across all rows, not just
// rows[0]. Confirmed live why this matters: when one field's generation
// silently failed for a day, rows[0] (Trending 1, alphabetically/order
// first) was the stale leftover while the other two fields were genuinely
// fresh from today, so a naive rows[0] read showed yesterday's date even
// though most of the section was current.
export function mostRecentDate(rows) {
  return new Date(Math.max(...rows.map(liveSince)));
}

// Picks the single most recent row for each field in `fields`, in that
// order — not just the first N rows in the batch, since stale rows from a
// retired field or a partially-failed cron run could otherwise crowd out a
// field that's actually still active. Drops anything past MAX_STALE_HOURS
// outright — better to show fewer cards than a visibly-dated one.
// The pick most recently published for each field — by when it went live
// rather than when it was generated, since a pick approved into the
// morning's slot can be older than one already live (an alternative from
// an earlier batch, say) and must still replace it.
export function latestByField(rows, fields) {
  return fields
    .map((field) =>
      rows.filter((r) => r.field === field).reduce((best, r) => (!best || liveSince(r) > liveSince(best) ? r : best), null)
    )
    .filter(Boolean)
    .filter(isFresh);
}

// Today's pick for each hero section. An admin's riddle preview (?riddlePreview,
// opened from /queue) stands in for the live riddle.
export function heroPicks(rows, previewRiddle) {
  return {
    newsTopics: latestByField(rows, NEWS_FIELDS),
    todayTopics: latestByField(rows, SPECIAL_FIELDS),
    quoteTopic: latestByField(rows, [QUOTE_FIELD])[0] || null,
    riddleTopic: previewRiddle || latestByField(rows, [RIDDLE_FIELD])[0] || null,
    perspectiveTopic: latestByField(rows, [PERSPECTIVE_FIELD])[0] || null,
  };
}

// The outlet behind a daily pick's source_url, as a plain domain
// ("npr.org"), for the small credit on its card and page. Null when there's
// no usable link — then nothing is shown rather than a made-up source.
export function sourceDomain(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.replace(/^www\./, "");
  } catch (_) {
    return null;
  }
}

// The daily pick a topic page was started from, if any (matched by its
// topic, so links from the email find it too).
export function pickForTopic(rows, topic) {
  return (rows || []).find((r) => r.topic === topic && r.source_url) || null;
}
