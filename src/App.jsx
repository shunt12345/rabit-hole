import { useState, useRef, useEffect, useMemo, Fragment } from "react";
import { Loader2, RotateCcw, Sparkles, ArrowUpRight, AlertCircle, BookOpen, ChevronRight, ChevronDown, Share2, Check, Shuffle, HelpCircle } from "lucide-react";
import {
  callClaude,
  streamTextFromPrompt,
  getLastActionsToday,
  getLastTrialStatus,
  writeNewsRootCache,
  writeNewsArticleCache,
  writeNodeCache,
  writeNodeArticleCache,
  TrialExhaustedError,
} from "./lib/api.js";
import { HYFAX_SYSTEM, OBSCURITY_LEVELS, FIXED_OBSCURITY } from "./lib/hyfaxSystemPrompt.js";
import { createPacedReveal } from "./lib/pacedReveal.js";
import { getCurrentUser, onAuthStateChange, isNewAccount } from "./lib/auth.js";
import { maybeReportSignUp, maybeReportLead } from "./lib/redditPixel.js";
import { getAttribution, isRedditVisit } from "./lib/attribution.js";
import { touchSession } from "./lib/visitor.js";
import { trackEvent } from "./lib/track.js";
import { recordChipTap, hasDismissedSignUpPrompt, dismissSignUpPrompt } from "./lib/chipTaps.js";
import { getProfile, getLifetimeFundedUsd } from "./lib/profile.js";
import AccountMenu from "./AccountMenu.jsx";
import LegalModal from "./LegalModal.jsx";
import { articleUserPrompt, ARTICLE_MAX_TOKENS } from "./lib/articlePrompt.js";
import { nextSurpriseTopic } from "./lib/surpriseTopics.js";
import UsageGauge from "./UsageGauge.jsx";
import MiniGauge from "./MiniGauge.jsx";
import AdCard from "./AdCard.jsx";
import RiddleGame from "./RiddleGame.jsx";
import { pickHouseAd, getHouseAdById, engagementStage } from "./lib/houseAds.js";
import { getSessionId } from "./lib/session.js";
import {
  getLocalHistory,
  saveLocalRoot,
  getAccountHistory,
  saveAccountRoot,
  migrateLocalHistoryToAccount,
} from "./lib/exploredHistory.js";
import { shareArticle } from "./lib/share.js";
import { savePendingThread, takePendingThread } from "./lib/pendingThread.js";
import { getAccessToken } from "./lib/auth.js";

const TYPE_COLOR = {
  root: "#C1552E",
  direct: "#E3A73C",
  indirect: "#7E9471",
  tangent: "#9C6B8C",
  custom: "#6C93A8",
};

const TYPE_LABEL = {
  direct: "Direct",
  indirect: "Indirect",
  tangent: "Tangent",
  custom: "Yours",
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A defensive cleanup, not just a prompt instruction — telling the model
// "no markdown" doesn't reliably stop it from reaching for *asterisks* to
// represent emphasis, especially under an enthusiastic tone that invites
// emphasis in the first place. Since this app renders plain text with no
// markdown parser, any asterisk that slips through shows up literally
// instead of turning into actual styling — so strip them outright rather
// than trust compliance alone. Runs on every streamed chunk as it arrives,
// not just the final text, so stray formatting never flashes on screen
// even mid-stream.
function stripMarkdown(text) {
  return text
    .replace(/\*{3,}/g, "") // *** or longer used as a bare separator/flourish
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/\*([^*]+)\*/g, "$1") // *italic*
    .replace(/\*+/g, ""); // anything left over, including an unmatched opening asterisk mid-stream
}

// turns any mention of a child's label inside a block of text into a
// clickable piece — used for both the short teaser/overview and the full
// article, so a name only needs to be written once to become a link
// wherever it shows up. Case-insensitive on purpose: child labels are
// stored Title Case (e.g. "Echo Chamber Radicalization"), but natural
// prose mid-sentence writes them lowercase ("...tips into echo chamber
// radicalization"). Confirmed live this was silently breaking links
// whenever the model wrote a mention in normal sentence case instead of
// matching the label's exact capitalization — the piece rendered as plain
// text with no visible sign it was ever supposed to be a link. Keeps
// whatever casing actually appears in the text (doesn't force Title Case
// mid-sentence), just matches regardless of case.
function linkifyText(text, children) {
  if (!children || !children.length || !text) return [text];
  const sorted = [...children].sort((a, b) => b.label.length - a.label.length);
  const pattern = new RegExp(`(${sorted.map((c) => escapeRegExp(c.label)).join("|")})`, "gi");
  const pieces = text.split(pattern);
  const byLabel = new Map(children.map((c) => [c.label.toLowerCase(), c]));
  return pieces.map((piece) => {
    const child = byLabel.get(piece.toLowerCase());
    return child ? { type: "link", label: piece, nodeId: child.id } : piece;
  });
}

// Inline thread links: the article marks 2-3 direct subtopics itself as
// [[phrase]] (see ARTICLE_TASK in hyfaxSystemPrompt.js), so it no longer
// has to wait for a separate call to supply link names first. The phrase
// stays in the sentence as written; its Title Case form becomes the child
// page's label.
const LINK_MARKER_RE = /\[\[([^[\]]+?)\]\]/g;

function toLinkLabel(phrase) {
  return phrase
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function stripLinkMarkers(text) {
  return (text || "").replace(LINK_MARKER_RE, "$1");
}

// Drops any "[[" or "]]" that isn't part of a complete [[link]] — a
// malformed marker should never show up as raw brackets in finished text.
function cleanStrayBrackets(text) {
  let out = "";
  let last = 0;
  for (const m of (text || "").matchAll(LINK_MARKER_RE)) {
    out += text.slice(last, m.index).replace(/\[\[|\]\]/g, "") + m[0];
    last = m.index + m[0].length;
  }
  return out + (text || "").slice(last).replace(/\[\[|\]\]/g, "");
}

// Article length is held by the token cap (the model reliably overshoots
// a word count it's only asked to keep), so a capped article usually stops
// mid-sentence — cut it back to its last complete sentence. Leaves text
// alone if it already ends cleanly or has no sentence end to cut back to.
function trimToLastSentence(text) {
  const t = (text || "").trimEnd();
  if (/[.!?]["'”’)\]]*$/.test(t)) return t;
  let cut = -1;
  for (const m of t.matchAll(/[.!?]["'”’)\]]*(?=\s)/g)) cut = m.index + m[0].length;
  return cut > 0 ? t.slice(0, cut) : t;
}

function linkLabelsIn(text) {
  return [...(text || "").matchAll(LINK_MARKER_RE)].map((m) => toLinkLabel(m[1])).filter(Boolean);
}

// A topic page's article opens with "TITLE: <display title>" (asked for in
// the user turn) — split it off so the heading can use it and the body
// never shows it. Holds the body back entirely while that first line is
// still streaming in. Cached articles from before this format have no
// title line and pass through untouched (the proxy prepends one for them).
function splitTitleLine(raw) {
  const text = (raw || "").replace(/^\s+/, "");
  if (!text.startsWith("TITLE:")) {
    return "TITLE:".startsWith(text) && text.length > 0 ? { title: null, body: "" } : { title: null, body: raw || "" };
  }
  const nl = text.indexOf("\n");
  if (nl === -1) return { title: null, body: "" };
  const title = text.slice("TITLE:".length, nl).trim();
  return { title: title || null, body: text.slice(nl + 1).replace(/^\s+/, "") };
}

// "Read more" content: real prose, not JSON, so no parsing needed beyond
// trimming stray markdown fences a model might add out of habit. Streams
// the article as it's generated instead of waiting for the whole thing —
// parses the API's server-sent-event chunks directly and calls onChunk
// with the accumulated text so far after every delta, so the screen can
// render it growing in real time rather than sitting on a spinner.
async function fetchArticleTextStreaming(topicLabel, path, onChunk, newsContext, nodeType, articleCacheKey, nodeCacheKey, onUsage, heroSource) {
  const userContent = articleUserPrompt({ topicLabel, path, newsContext, nodeType });
  return streamTextFromPrompt(HYFAX_SYSTEM, userContent, ARTICLE_MAX_TOKENS, 30000, "article", onChunk, nodeType, articleCacheKey, nodeCacheKey, onUsage, heroSource);
}

// "Dig deeper" — this app is entertainment, not a research tool, so this is
// deliberately capped to ONE extra round per node (enforced by the caller
// via node.deepened) rather than open-ended pagination. The prompt gets the
// existing article text so it can continue naturally instead of repeating
// itself, and is explicitly told not to try to be exhaustive — a
// satisfying next layer for someone who wants a little more, not a
// dissertation.
async function fetchArticleContinuationStreaming(topicLabel, path, existingArticle, onChunk, nodeType) {
  const today = new Date().toISOString().slice(0, 10);
  const userContent = `TASK: continue article

Today's date is ${today}.

Path so far: ${path.join(" → ")}
Topic: "${topicLabel}"

What they already read:
"""
${existingArticle}
"""`;

  return streamTextFromPrompt(HYFAX_SYSTEM, userContent, 500, 30000, "continuation", onChunk, nodeType);
}

// Chips are only the indirect/tangent leaps now — direct subtopics are
// inline [[links]] in the article. Still tolerates ONE direct chip, since
// topics cached before that change were stored with one.
function branchMix() {
  const { indirect, tangent } = OBSCURITY_LEVELS[FIXED_OBSCURITY].mix;
  return { direct: 1, indirect, tangent };
}

// The prompt ASKS for an exact branch mix, but nothing enforced that on the
// way back — the raw API response was passed straight through, so any time
// the model returned an extra item (a common way models drift from numeric
// constraints, especially across several categories at once) it just
// silently rendered, throwing off the intended mix. This caps each
// category at its real target count, dropping any overflow, and ignores
// any item with a type that isn't one of the three real branch types at all.
function normalizeChildren(rawChildren) {
  const mix = branchMix();
  const buckets = { direct: [], indirect: [], tangent: [] };
  (rawChildren || []).forEach((c) => {
    if (buckets[c.type]) buckets[c.type].push(c);
  });
  return [...buckets.direct.slice(0, mix.direct), ...buckets.indirect.slice(0, mix.indirect), ...buckets.tangent.slice(0, mix.tangent)];
}

// The page's own article (already written by the time chips are generated)
// rides along so the chips reach past it — confirmed live that without it
// they'd sometimes offer a thread the article had just explained.
function childPrompt(label, path, existingLabels, depth, articleText) {
  const articleNote = articleText
    ? `\n\nThe reader has just read this article on this page — every branch must go somewhere it doesn't, never re-offer something it already explains:\n\"\"\"\n${articleText}\n\"\"\"`
    : "";
  return `TASK: expand node

Path so far: ${path.join(" → ")}
Now expanding: "${label}" (${depth} click${depth === 1 ? "" : "s"} away from the original topic)

Do not repeat or closely rephrase any of these already-shown labels: ${
    existingLabels.slice(-40).join(", ") || "none"
  }${articleNote}`;
}

// What a free account gets per day, shown in the limit's sign-up offer.
// Mirrors the proxy's SIGNED_IN_SEARCH_LIMIT default; the proxy's own
// response headers stay the source of truth once a call comes back.
const SIGNED_IN_PAGE_LIMIT = 10;

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return idCounter;
}

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
const TRENDING_TOPICS_URL = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/trending_topics_cache?select=id,field,topic,teaser,source_url,options,category,direction,generated_at,riddle_game,publish_at&status=eq.approved&order=generated_at.desc,id.desc&limit=40`;
const NEWS_FIELDS = ["Trending 1", "Trending 2"];
// What each internal field key actually displays as — kept separate from
// the field key itself so latestByField (below) can still tell the two
// mainstream picks apart for lookup purposes while both show the same
// "Trending" badge on screen; a field with no entry here just falls back
// to showing its raw key.
const NEWS_FIELD_LABELS = { "Trending 1": "Trending", "Trending 2": "Trending" };
const SPECIAL_FIELDS = ["This Day In History", "Word Of The Day"];
// Same source table/cron cadence as SPECIAL_FIELDS (see promptForField in
// generate-trending-topics), but rendered as its own dedicated section
// above "Trending" instead of grouped into "Today" — deliberately kept OUT
// of SPECIAL_FIELDS above so it doesn't also show up a second time in that
// list.
const QUOTE_FIELD = "Quote Of The Day";
// "Reverse Hyfax" — a withheld-register riddle describing a topic without
// naming it, plus a multiple-choice guess (the real topic + 2 decoys from
// `options`). Same source table/cadence as SPECIAL_FIELDS but kept out of
// that list for the same reason QUOTE_FIELD is: it needs its own card
// treatment (the guess UI), not the plain topic+teaser list layout.
const RIDDLE_FIELD = "Riddle";
// Reframes something by shifting scale (zoom into the microscopic/
// molecular, or out to the planetary/cosmic) rather than searching for
// what's currently interesting — same source table/cadence as
// SPECIAL_FIELDS, but kept out of that list for the same reason
// QUOTE_FIELD/RIDDLE_FIELD are: its own dedicated card, placed right after
// "Today" rather than grouped into that list (see
// supabase/functions/generate-trending-topics' perspectivePrompt/
// nextPerspectiveFocus for the Human/Nature/Space rotation this reads).
const PERSPECTIVE_FIELD = "Perspective";

// No longer rendered as hero chips (removed in favor of "Spin a thread"
// taking that spot), but still the precomputed-cache lookup table for the
// Reddit ad landing flow's ?q= override (see the Reddit entry-flow effect
// below) — matched EXACTLY (topic string) against the seed rows in
// migration 0035, since that's what lets a matching ?q= hit the
// precomputed news_root_cache entry instead of a fresh ~9s generation.
// The Reddit ad's own default landing topic ("why does bread go stale" as
// of migration 0039) is intentionally NOT one of these — this array is
// specifically the home-screen chip set, a separate surface from the
// Reddit campaign's pinned landing. The Reddit flow below still hits the
// same news_root_cache precompute either way (any non-empty newsContext
// is enough to trigger that cache-key lookup), it just doesn't get its
// teaser from this list.
const STARTER_QUESTIONS = [
  { topic: "why do cats purr", teaser: "A low hum that might double as a bone-healing frequency." },
  { topic: "why do we dream", teaser: "Your brain runs a nightly simulation nobody fully understands yet." },
  { topic: "why is the sky blue", teaser: "Sunlight gets ambushed by the air itself before it reaches your eyes." },
  { topic: "why do we get goosebumps", teaser: "A shiver left over from fur you stopped growing thousands of years ago." },
];

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
function liveSince(row) {
  return new Date(row.publish_at || row.generated_at).getTime();
}
function isFresh(row) {
  return Date.now() - liveSince(row) <= MAX_STALE_HOURS * 60 * 60 * 1000;
}

// The "as of" badge's actual date — the max across all rows, not just
// rows[0]. Confirmed live why this matters: when one field's generation
// silently failed for a day, rows[0] (Trending 1, alphabetically/order
// first) was the stale leftover while the other two fields were genuinely
// fresh from today, so a naive rows[0] read showed yesterday's date even
// though most of the section was current.
function mostRecentDate(rows) {
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
function latestByField(rows, fields) {
  return fields
    .map((field) =>
      rows.filter((r) => r.field === field).reduce((best, r) => (!best || liveSince(r) > liveSince(best) ? r : best), null)
    )
    .filter(Boolean)
    .filter(isFresh);
}

export default function Hyfax() {
  const [topic, setTopic] = useState("");
  const [inputVal, setInputVal] = useState("");
  // Whether inputVal currently holds a "Surprise me" pick rather than
  // something the reader typed themselves — just swaps the little link
  // below the input between "Surprise me" and "Spin again"; the actual
  // input + Dig In button ARE the accept action, no separate window/card.
  // Cleared the moment the input is edited by hand, since it's no longer
  // the untouched candidate at that point.
  const [isSurprise, setIsSurprise] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState(null);
  // Soft sign-up nudge — shows once, after the 3rd "Explore next" chip tap
  // in a session, for anyone not already signed in. Never blocks exploring
  // (see its render below: a small dismissible bar, not a modal) and never
  // shows again this session once dismissed (see lib/chipTaps.js).
  const [showSignUpPrompt, setShowSignUpPrompt] = useState(false);
  const [trendingTopics, setTrendingTopics] = useState([]);
  // "Continue exploring" history (see lib/exploredHistory.js) — local
  // (localStorage) by default, swapped for the signed-in account version
  // by the effect below once `user` resolves. Starting from the local
  // read means an anonymous visitor's history is on screen instantly,
  // with no flash of empty state while the account fetch (if any) is
  // still in flight.
  const [exploredHistory, setExploredHistory] = useState(() => getLocalHistory());
  // Which "Trending" card was clicked, so only that one highlights
  // instead of all three dimming identically once rootLoading flips on.
  const [selectedNewsIdx, setSelectedNewsIdx] = useState(null);
  // Same idea, for the "Today" list (This Day In History / Word Of The Day).
  const [selectedTodayIdx, setSelectedTodayIdx] = useState(null);
  // Same idea, for the single Quote Of The Day card — a plain boolean since
  // there's only ever one of these on screen, unlike the indexed lists above.
  const [selectedQuote, setSelectedQuote] = useState(false);
  // Same idea, for the single Perspective card.
  const [selectedPerspective, setSelectedPerspective] = useState(false);
  // Riddle card: which decoy(s) the reader has already guessed wrong, so
  // that option can grey out and stay wrong instead of being re-clickable
  // (not a scored quiz — just stops a reader from immediately re-tapping
  // the same wrong answer). Reset below whenever the riddle's real answer
  // changes (a new day's pick), so yesterday's wrong guesses don't linger.
  const [riddleWrongPicks, setRiddleWrongPicks] = useState([]);
  const [selectedRiddle, setSelectedRiddle] = useState(false);
  // Raw action count from the proxy's X-Session-Actions-Today header —
  // kept for the existing 300/day safety-net visibility; the real
  // free-trial gate (below) is search-count-based, not this.
  const [actionsToday, setActionsToday] = useState(0);
  // Section B of the production punch list (free-tier enforcement) — real
  // trial status from the proxy: how many free searches used, the limit,
  // and whether this identity is funded (and so not gated at all). Drives
  // hiding/disabling News/Today/Dig Deeper once the trial's used up.
  // Starts optimistic (assume within trial) since the real status isn't
  // known until after the first proxy call of the session.
  const [trialStatus, setTrialStatus] = useState(() => ({ searchesUsed: 0, searchLimit: isRedditVisit() ? 10 : 4, funded: false }));
  const syncActionsToday = () => {
    const n = getLastActionsToday();
    if (n != null) setActionsToday(n);
    const t = getLastTrialStatus();
    if (t != null) setTrialStatus(t);
  };

  // Accounts (production punch list, Section A) — first pass: just knowing
  // who's signed in. null = signed out, an object = signed in.
  const [user, setUser] = useState(null);
  useEffect(() => {
    getCurrentUser().then(setUser);
    return onAuthStateChange((u) => {
      setUser(u);
      if (u) setShowSignUpPrompt(false);
      // A free account counts its own pages, so a visitor who just signed
      // up at the limit can keep going in this tab right away. The next
      // proxy response replaces this with the account's real count.
      if (u) {
        setTrialStatus((prev) =>
          prev.funded || prev.searchLimit >= SIGNED_IN_PAGE_LIMIT ? prev : { searchesUsed: 0, searchLimit: SIGNED_IN_PAGE_LIMIT, funded: false }
        );
      }
      // Reddit Ads conversion tracking (see lib/redditPixel.js) — reports a
      // "SignUp" event the first time this fires for a genuinely new
      // account, no-ops for a returning sign-in or when no Reddit Pixel is
      // configured.
      maybeReportSignUp(u);
      // Adoption analytics' own "signup" event (see lib/track.js) — same
      // isNewAccount() check as the Reddit pixel above, just a separate
      // concern (every signup counts here, Pixel-configured or not).
      if (isNewAccount(u)) {
        const { sessionId } = touchSession();
        trackEvent("signup", { sessionId });
      }
    });
  }, []);

  // Adoption analytics' "land" event (see lib/track.js + lib/visitor.js) —
  // fires once per NEW session only (a session being a run of activity
  // with no gap over 30 minutes), never on every mount/re-render. Runs
  // once on first mount; touchSession() itself is what decides whether
  // this is actually a new session or a continuation of one already in
  // progress from an earlier page in the last 30 minutes.
  useEffect(() => {
    const { sessionId, isNewSession } = touchSession();
    if (isNewSession) trackEvent("land", { sessionId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swaps "continue exploring" over to the account tier once someone's
  // signed in, so it follows them across devices instead of staying
  // stuck on this one browser (see lib/exploredHistory.js). On the
  // transition into a session (user goes from null to a real user), first
  // migrates whatever local history already exists into the account —
  // otherwise signing in would look like it wiped out history that was
  // sitting right there a second ago. Signing back out falls back to
  // local rather than clearing the row on screen.
  useEffect(() => {
    if (!user?.id) {
      setExploredHistory(getLocalHistory());
      return;
    }
    let cancelled = false;
    migrateLocalHistoryToAccount(user.id)
      .then(() => getAccountHistory(user.id))
      .then((history) => {
        if (!cancelled) setExploredHistory(history);
      })
      .catch((e) => console.error("Hyfax: failed to load account explored history", e));
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // One place both startTopic and resumeExploredRoot call once a root's
  // overview + children are in hand — picks local vs account storage
  // based on whether anyone's signed in, then refreshes exploredHistory
  // from that same tier so the hero screen reflects the real save
  // (rather than optimistically assuming it worked).
  const recordExploredRoot = async (entry) => {
    if (user?.id) {
      await saveAccountRoot(user.id, entry);
      setExploredHistory(await getAccountHistory(user.id));
    } else {
      saveLocalRoot(entry);
      setExploredHistory(getLocalHistory());
    }
  };

  // Production punch list, Section C (funded experience): the signed-in
  // user's own feature-toggle preferences (News/Today/Dig Deeper — Explore
  // node count is deliberately excluded, see AccountMenu.jsx). null while
  // signed out or still loading; refreshed whenever `user` changes
  // (including after AccountMenu writes a toggle, since that flips through
  // the same auth state) and passed down so AccountMenu doesn't need a
  // second, out-of-sync copy of the same row.
  const [profile, setProfile] = useState(null);
  const refreshProfile = () => {
    if (!user) {
      setProfile(null);
      return;
    }
    getProfile().then(setProfile);
  };
  useEffect(refreshProfile, [user]);

  // Lifetime funded total, for UsageGauge (now on the hero page — see
  // that file — rather than tucked inside the account modal). Was
  // previously fetched inside AccountMenu itself; lives here instead so
  // the hero page can read it too, with AccountMenu getting it as a prop
  // and calling onLifetimeFundedRefresh after a successful top-up.
  const [lifetimeFunded, setLifetimeFunded] = useState(null);
  const refreshLifetimeFunded = () => {
    if (!user) {
      setLifetimeFunded(null);
      return;
    }
    getLifetimeFundedUsd().then(setLifetimeFunded);
  };
  useEffect(refreshLifetimeFunded, [user]);

  // Real-time "is this account funded" check, computed directly from the
  // profile row (fetched independently, on sign-in and after checkout)
  // rather than trialStatus.funded. That field only updates after a full
  // round-trip through rabbit-hole-proxy, so relying on it here meant a
  // signed-in funded user could sit on a stale "not funded" read (from the
  // optimistic initial state, or simply not having made a proxy call yet
  // this session) — which made toggling News/Today off look broken, since
  // the gating below always falls back to "show everything" whenever it
  // doesn't yet believe the account is funded. profile.balanceUsd is a
  // straight read of the real row, so this can't lag behind reality.
  const funded = !!profile && profile.balanceUsd > 0;

  // Toggle gating only ever applies to a FUNDED account — the free-trial
  // window (not yet exhausted, per Section B) keeps its existing
  // unconditional full access regardless of any toggle's stored default,
  // matching the monetization outline doc's Section 14.1 ("full access to
  // every function" during the trial, à-la-carte toggles only once funded).
  const trialExhausted = !funded && trialStatus.searchesUsed >= trialStatus.searchLimit;
  // Read from async callbacks (an article finishing, then deciding whether
  // to fetch chips) that would otherwise see a stale render's value.
  const trialExhaustedRef = useRef(trialExhausted);
  trialExhaustedRef.current = trialExhausted;

  // House-ad staging (Section H) — every AdCard placement below is
  // already gated on `!funded` (funded accounts don't see ads at all), so
  // this only ever needs to reflect an unsubscribed session's free-trial
  // usage.
  const adStage = engagementStage(trialStatus);
  const newsVisible = !funded || !!profile?.featureNews;
  const todayVisible = !funded || !!profile?.featureToday;
  const riddleVisible = !funded || !!profile?.featureRiddle;
  const digDeeperVisible = !funded || !!profile?.featureDigDeeper;

  const nodesRef = useRef([]);
  const selectedIdRef = useRef(null);
  const contentRef = useRef(null);
  const heroRef = useRef(null);
  const articleTextRef = useRef(null);

  // Highlight-to-explore: uses the browser's OWN native text selection
  // (long-press then drag the OS's own handles, exactly like copying text)
  // rather than building custom drag handles — the OS already does that
  // well, and reinventing it would both be a lot of fragile work and would
  // fight whatever the platform already does natively. This just watches
  // for a selection to settle inside the article text specifically (not
  // the title, not a chip label) and offers a button near it.
  //
  // selectionchange fires continuously while dragging the selection handles
  // — many times a second — so this is debounced to update only once the
  // selection has actually settled, both to avoid visible jitter in the
  // floating button's position and to avoid re-rendering on every tiny
  // handle movement.
  const [selectionInfo, setSelectionInfo] = useState(null); // { text, top, left } | null
  const [legalDoc, setLegalDoc] = useState(null); // "terms" | "privacy" | null
  const [shareStatus, setShareStatus] = useState("idle"); // idle | sharing | copied | error

  // House ads' CTA opens the account/funds modal — AccountMenu owns that
  // modal's open state locally, so this is just a one-way "please open"
  // signal passed down as a prop (see AccountMenu.jsx's openSignal effect).
  // Any change opens it, so a simple increment is enough; the value itself
  // is never read for anything else.
  const [accountModalSignal, setAccountModalSignal] = useState(0);
  const openAccountModal = () => setAccountModalSignal((n) => n + 1);
  const selectionDebounceRef = useRef(null);
  useEffect(() => {
    const handleSelectionChange = () => {
      if (selectionDebounceRef.current) clearTimeout(selectionDebounceRef.current);
      selectionDebounceRef.current = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          setSelectionInfo(null);
          return;
        }
        const text = sel.toString().trim();
        // an empty/whitespace-only selection, or something absurdly long
        // (someone dragged across several paragraphs) isn't a real "what's
        // this word/phrase" moment — bail out rather than offer to explore
        // half an article as a single topic
        if (!text || text.length > 80) {
          setSelectionInfo(null);
          return;
        }
        const range = sel.getRangeAt(0);
        if (!articleTextRef.current || !articleTextRef.current.contains(range.commonAncestorContainer)) {
          setSelectionInfo(null);
          return;
        }
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          setSelectionInfo(null);
          return;
        }
        setSelectionInfo({ text, bottom: rect.bottom, left: rect.left + rect.width / 2 });
      }, 150);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (selectionDebounceRef.current) clearTimeout(selectionDebounceRef.current);
    };
  }, []);

  // 100vh (and window.innerHeight) is unreliable once the mobile keyboard
  // opens — it doesn't shrink to the actual visible area, so the page stays
  // sized for the full pre-keyboard height and the browser has to improvise
  // scroll compensation to keep the focused input in view. window.visualViewport
  // DOES track the keyboard correctly and is what the layout should actually
  // be driven by instead.
  const getViewportH = () => {
    if (typeof window === "undefined") return 800;
    return window.visualViewport ? window.visualViewport.height : window.innerHeight;
  };
  const [viewportH, setViewportH] = useState(getViewportH);
  useEffect(() => {
    const update = () => setViewportH(getViewportH());
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update); // some browsers report keyboard changes via scroll, not resize
    } else {
      window.addEventListener("resize", update);
    }
    return () => {
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      } else {
        window.removeEventListener("resize", update);
      }
    };
  }, []);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Every navigation — a chip, a breadcrumb segment, an in-text link, or a
  // fresh topic — should land you at the top of the new content, not
  // wherever you happened to have scrolled to on the previous one.
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    setSelectionInfo(null);
  }, [selectedId]);

  // Creates the child node objects — no position/layout concerns at all
  // here, since there's no graph to place anything on.
  const placeChildren = (parent, children) =>
    children.map((c) => ({
      ...c,
      id: nextId(),
      parentId: parent.id,
      depth: parent.depth + 1,
      generated: false,
      loading: false,
      error: null,
      article: null,
      articleLoading: false,
      articleStreaming: false,
      articleError: null,
      deepened: false,
      deepenError: null,
    }));

  // Tapping the button always does this synchronously and immediately, regardless
  // of anything else — proves the click registered even if startTopic itself
  // fails in some unexpected way.
  const handleStartClick = () => {
    console.log("Hyfax: Dig in tapped, value =", JSON.stringify(inputVal));
    try {
      if (!inputVal.trim()) {
        setRootError("Type a topic first.");
        return;
      }
      setSelectedNewsIdx(null);
      setSelectedTodayIdx(null);
      setSelectedQuote(false);
      setSelectedPerspective(false);
      startTopic(inputVal, undefined, isSurprise ? "spin_a_thread" : "freeform");
    } catch (syncErr) {
      console.error("Hyfax: synchronous error on click", syncErr);
      setRootError(`Unexpected error: ${syncErr.message || syncErr}`);
      setRootLoading(false);
    }
  };

  // A topic page no longer waits on a separate call for its title, overview
  // and chips before anything else can happen: the page (and its node)
  // exists the instant a topic is submitted, and the selection effect below
  // starts its article straight away. The article supplies its own title
  // line and inline [[links]]; the chips come after it (see expandNode).
  // presetChildren: thread cards the page opens with instead of generating
  // its own — the riddle's answer page uses its clues (see RiddleGame).
  const startTopic = (raw, newsContext, heroSource, presetChildren) => {
    const t = raw.trim();
    if (!t) return;
    setRootError(null);
    idCounter = 0;
    const root = {
      id: nextId(),
      label: t,
      fullTopic: t,
      teaser: "",
      overview: "",
      type: "root",
      depth: 0,
      generated: false,
      loading: false,
      error: null,
      article: null,
      articleLoading: false,
      articleStreaming: false,
      articleError: null,
      deepened: false,
      deepenError: null,
      newsContext: newsContext || null,
      heroSource: heroSource || null,
    };
    // Marked generated so the page doesn't fetch chips of its own on top.
    const preset = presetChildren?.length ? placeChildren(root, presetChildren) : [];
    if (preset.length) root.generated = true;
    setTopic(t);
    nodesRef.current = [root, ...preset];
    setNodes([root, ...preset]);
    setSelectedId(root.id);
  };

  // Saves a topic page to "continue exploring" once it has something worth
  // returning to. The stored overview is the article's first sentence, used
  // as the preview line (topic pages no longer have a separate overview).
  const recordRoot = (root) => {
    const firstSentence = (stripLinkMarkers(root.article || "").match(/^[\s\S]*?[.!?](\s|$)/) || [""])[0].trim();
    const children = nodesRef.current.filter((n) => n.parentId === root.id);
    recordExploredRoot({ label: root.label, fullTopic: root.fullTopic, overview: firstSentence || root.overview, children }).catch((e) =>
      console.error("Hyfax: failed to record explored topic", e)
    );
  };

  // Jumps back into a previously-explored topic (see lib/exploredHistory.js
  // — local or account tier, whichever recordExploredRoot is currently
  // using) — rebuilds the exact root + children it had before straight
  // from the stored snapshot, with no network call at all. Free in every
  // sense: no Claude generation, no trial-search count, works even with
  // the trial exhausted.
  const resumeExploredRoot = (entry) => {
    idCounter = 0;
    const root = {
      id: nextId(),
      label: entry.label,
      fullTopic: entry.fullTopic || entry.label,
      teaser: "",
      overview: entry.overview || "",
      type: "root",
      depth: 0,
      generated: true,
      loading: false,
      error: null,
      article: null,
      articleLoading: false,
      articleStreaming: false,
      articleError: null,
      deepened: false,
      deepenError: null,
      newsContext: null,
      resumed: true,
    };
    const children = placeChildren(root, entry.children || []);
    const newNodes = [root, ...children];

    setTopic(root.label);
    nodesRef.current = newNodes;
    setNodes(newNodes);
    setSelectedId(root.id);
    recordExploredRoot({ label: root.label, fullTopic: root.fullTopic, overview: root.overview, children }).catch(
      (e) => console.error("Hyfax: failed to record explored topic", e)
    );
  };

  // Riddle preview (?riddlePreview=<id>, opened from /queue): an admin plays
  // a not-yet-live riddle on the real hero page. Fetched through
  // admin-review-queue with the signed-in admin's token, so it only works
  // for an admin; anyone else just sees the live riddle.
  const [previewRiddle, setPreviewRiddle] = useState(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("riddlePreview");
    if (!id || !user) return;
    (async () => {
      try {
        const token = await getAccessToken();
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-review-queue`, {
          method: "POST",
          headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "getRow", id: Number(id) }),
        });
        const data = res.ok ? await res.json() : null;
        if (data?.row?.field === RIDDLE_FIELD) setPreviewRiddle({ ...data.row, preview: true });
      } catch (e) {
        console.error("Hyfax: riddle preview failed", e);
      }
    })();
  }, [user?.id]);

  // Back from the sign-in link: reopens the thread saved when "Sign up" was
  // tapped at the free limit (see lib/pendingThread.js), on the page they
  // were reading. Runs before the ?topic= and Reddit landing effects below,
  // which both stand down once a thread is open.
  useEffect(() => {
    const saved = takePendingThread();
    if (!saved || nodesRef.current.length > 0) return;
    idCounter = Math.max(0, ...saved.nodes.map((n) => n.id));
    nodesRef.current = saved.nodes;
    setNodes(saved.nodes);
    if (saved.topic) setTopic(saved.topic);
    setSelectedId(saved.nodes.some((n) => n.id === saved.selectedId) ? saved.selectedId : saved.nodes[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reads a starting topic straight from the URL on load, e.g.
  // ?topic=octopus%20cognition — the foundation piece for anything that
  // wants to hand off INTO Hyfax from somewhere else (a bookmarklet,
  // a browser extension, a link shared from another app). This alone
  // doesn't capture text from other webpages — it's the landing side of
  // that handoff, what any of those tools would actually link to. Only
  // fires once, on first mount, and only if nothing's already loaded, so
  // it can't interfere with normal typed-topic use or accidentally
  // re-trigger on re-renders.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const urlTopic = params.get("topic");
      // Skipped on a Reddit-attributed visit — that gets its own richer
      // handling (below: ?q= override, autofire straight onto the topic
      // page) rather than the plain auto-fire this path does. The two
      // params aren't expected to co-occur in practice.
      if (urlTopic && urlTopic.trim() && nodesRef.current.length === 0 && !isRedditVisit()) {
        startTopic(urlTopic, undefined, "url_param");
      }
    } catch (e) {
      console.error("Hyfax: failed to read topic from URL", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reddit ad landing flow (see lib/attribution.js + the ad brief this was
  // built for): a Reddit visitor never sees the plain hero — the exact
  // question the ad shows someone typing gets submitted for them,
  // immediately, no tap required, landing straight on that topic's page
  // (the same streaming-in-place every normal topic transition already
  // uses — no separate loading UI). Defaults to "why
  // does bread go stale" (the current campaign's own example — see
  // migration 0039) but honors ?q= so a future ad campaign can point at a
  // different starter question without a code change. Only ever fires
  // once, and only if nothing's already loaded (matches the ?topic=
  // effect's own guard above).
  useEffect(() => {
    if (!isRedditVisit() || nodesRef.current.length > 0) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const q = (params.get("q") || "why does bread go stale").trim();
      if (!q) return;
      // A matching precomputed starter question (see migration 0035 + the
      // seed script) gets its real cached teaser as newsContext, so this
      // hits the SAME cache the starter chips do; a ?q= override with no
      // precomputed match still passes a non-null newsContext (so a cache
      // write attempt is harmless best-effort, per handleNewsCacheWrite's
      // own existence check) and just falls through to a fresh generation.
      const matchedStarter = STARTER_QUESTIONS.find((s) => s.topic.toLowerCase() === q.toLowerCase());
      startTopic(q, matchedStarter?.teaser || "From a Reddit ad", "reddit_ad_prefill");
    } catch (e) {
      console.error("Hyfax: failed to auto-start Reddit ad landing", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetches the latest cached batch of "Trending" topics — a plain read
  // against Supabase's REST API with the anon key (RLS allows public
  // SELECT on this table). Fails silently: if it's empty or the request
  // errors, the section just doesn't render rather than showing an error
  // on the hero page over what's a nice-to-have, not core functionality.
  useEffect(() => {
    let cancelled = false;
    const headers = {
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    };
    // Falls back to the query without the newer columns if the database
    // doesn't have them yet (migrations 0053, 0056), so the hero picks
    // never depend on a migration having run.
    fetch(TRENDING_TOPICS_URL, { headers })
      .then((res) =>
        res.ok ? res : fetch(TRENDING_TOPICS_URL.replace(",riddle_game", "").replace(",publish_at", ""), { headers })
      )
      .then((res) => (res.ok ? res.json() : []))
      .then((rows) => {
        if (!cancelled) setTrendingTopics(Array.isArray(rows) ? rows : []);
      })
      .catch((e) => console.error("Hyfax: failed to load trending topics", e));
    return () => {
      cancelled = true;
    };
  }, []);

  const pathToNode = (node) => {
    const path = [];
    let cur = node;
    while (cur) {
      path.unshift(cur.label);
      cur = nodesRef.current.find((n) => n.id === cur.parentId);
    }
    return path;
  };

  // same idea as pathToNode, but returns the actual node objects (root
  // first) instead of just their labels — what the breadcrumb trail renders
  const nodePathToRoot = (node) => {
    const path = [];
    let cur = node;
    while (cur) {
      path.unshift(cur);
      cur = nodesRef.current.find((n) => n.id === cur.parentId);
    }
    return path;
  };

  const expandNode = async (nodeId, articleText) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node || node.generated || node.loading) return;
    node.loading = true;
    node.error = null;
    setNodes([...nodesRef.current]);

    const path = pathToNode(node);
    // A direct child of an already-cached root (Trending/Today/Quote/
    // Riddle/Starter-Question) is expanded identically for every visitor —
    // see migration 0036_node_cache.sql. Scoped to depth 1 only (one click
    // from the root): a grandchild's expansion depends on the specific path
    // taken to reach it, isn't shared the way a root's own direct children
    // are, and caching it would grow combinatorially for little benefit.
    const root = node.depth === 1 ? nodesRef.current.find((n) => n.id === node.parentId) : null;
    const branchCacheEligible = !!(root && root.type === "root" && root.newsContext);
    const nodeCacheKey = branchCacheEligible ? `${root.fullTopic}::${node.label}` : undefined;
    // Determinism requirement for a cache the WHOLE campaign shares: this
    // exact prompt must come out the same for every visitor. `existingLabels`
    // is normally derived from the visitor's own full exploration history
    // (nodesRef.current), which differs session to session — using that here
    // would make two visitors' "same" cached branch diverge depending on
    // what else they'd already dug into. For a cache-eligible node, use only
    // the root + its own direct children instead — a fixed set determined
    // entirely by the (already-cached, therefore fixed) root itself.
    //
    // This node's own inline [[links]] (already created from its article,
    // which now finishes first) are always excluded too, so the chips never
    // repeat a thread the article already offers.
    const ownLinkLabels = nodesRef.current.filter((n) => n.parentId === node.id).map((n) => n.label);
    const existingLabels = branchCacheEligible
      ? [root.label, ...nodesRef.current.filter((n) => n.parentId === root.id).map((n) => n.label), ...ownLinkLabels]
      : nodesRef.current.map((n) => n.label);
    // A cached topic's (Trending/Today/Quote/Starter) own chips are shared
    // by every visitor too — read from and written to its news_root_cache
    // row, keyed the same as its article.
    const rootCacheKey = node.type === "root" && node.newsContext ? node.fullTopic : undefined;
    let nodeUsage = null;

    try {
      const data = await callClaude(
        HYFAX_SYSTEM,
        childPrompt(node.label, path, existingLabels, node.depth + 1, stripLinkMarkers(articleText ?? node.article ?? "")),
        "expand",
        nodeCacheKey,
        (usage) => {
          nodeUsage = usage;
        },
        rootCacheKey
      );
      if (nodeCacheKey) writeNodeCache(nodeCacheKey, data.children, nodeUsage);
      if (rootCacheKey) writeNewsRootCache(rootCacheKey, node.label, "", data.children, nodeUsage);
      const taken = new Set(ownLinkLabels.map((l) => l.toLowerCase()));
      // A chip named outright in a new-format article (one with [[links]])
      // only repeats what the reader just read, so it's dropped. Older
      // cached articles mention their chips by design, so they keep them,
      // as does a hand-authored cached chip marked `pinned` (the Reddit
      // landing's article points at its cards by name — migration 0042).
      const article = articleText ?? node.article ?? "";
      const articlePlain = linkLabelsIn(article).length ? stripLinkMarkers(article).toLowerCase() : "";
      const fresh = normalizeChildren(data.children).filter(
        (c) =>
          c?.label &&
          !taken.has(c.label.toLowerCase()) &&
          (c.pinned || !(articlePlain && articlePlain.includes(c.label.toLowerCase())))
      );
      const children = placeChildren(node, fresh);
      node.loading = false;
      node.generated = true;
      const newNodes = [...nodesRef.current, ...children];
      nodesRef.current = newNodes;
      setNodes(newNodes);
      if (node.type === "root") recordRoot(node);
    } catch (e) {
      console.error("Hyfax: expandNode failed", e);
      node.loading = false;
      node.error = e.message || "Dig failed — try again.";
      setNodes([...nodesRef.current]);
    } finally {
      syncActionsToday();
    }
  };

  // Fetches the full "read more" article for a node, on demand — nothing is
  // fetched until the person actually opens that node. The article streams
  // in as it's generated rather than appearing all at once when it's done,
  // so reading starts within a second or two; the result is cached on the
  // node so re-opening it later never re-streams.
  const loadArticle = async (nodeId) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node || node.article || node.articleLoading) return;
    node.articleLoading = true;
    node.articleStreaming = false;
    node.articleError = null;
    setNodes([...nodesRef.current]);

    // Optimistic bump — this is the actual unit that counts as "one
    // search" now (see rabbit-hole-proxy's countSearches): every genuinely
    // fresh page dug into, root or child, link or chip or custom
    // highlight, fires exactly one of these. Same "updates the instant it
    // happens" feel as nodes.length ("N thoughts uncovered") instead of
    // sitting frozen until the call finishes. Can only ever be off by
    // however much the real server figure differs, and syncActionsToday()
    // in the finally block below overwrites this with that real number
    // the moment the call completes (correcting it back down if the call
    // was actually blocked, e.g. trial exhausted), so it can't drift
    // permanently wrong.
    setTrialStatus((prev) => ({ ...prev, searchesUsed: Math.min(prev.searchesUsed + 1, prev.searchLimit) }));

    const path = pathToNode(node);
    // The ROOT of a news/today/quote-sourced topic caches its article — same
    // scoping as newsCacheKey itself (see startTopic). Confirmed live this
    // was missing entirely: every visitor who dug into the same Trending/
    // Today/Quote root got a fresh, differently-worded article every time,
    // duplicating real Anthropic cost for identical content.
    const articleCacheKey = node.type === "root" && node.newsContext ? node.fullTopic : undefined;
    // One level deeper (see expandNode's branchCacheEligible/nodeCacheKey
    // and migration 0036_node_cache.sql): a DIRECT child of that same
    // cached root has exactly one path to it (root → this child), so its
    // article is just as shareable as the root's own — unlike a
    // grandchild, whose article depends on the specific further path taken
    // to reach it and stays uncached.
    const root = node.type !== "root" && node.depth === 1 ? nodesRef.current.find((n) => n.id === node.parentId) : null;
    const nodeCacheKey = root && root.type === "root" && root.newsContext ? `${root.fullTopic}::${node.label}` : undefined;
    let nodeUsage = null;
    const reveal = createPacedReveal((revealed) => {
      node.article = stripMarkdown(revealed);
      setNodes([...nodesRef.current]);
    });

    // Turns each closed [[link]] into a real child page as soon as it has
    // streamed in, so links are tappable while the rest is still writing.
    const addLinkChildren = (body) => {
      const taken = new Set(nodesRef.current.filter((n) => n.parentId === node.id).map((n) => n.label.toLowerCase()));
      taken.add(node.label.toLowerCase());
      const fresh = [];
      for (const label of linkLabelsIn(body)) {
        if (taken.has(label.toLowerCase()) || fresh.length >= 4) continue;
        taken.add(label.toLowerCase());
        fresh.push({ label, teaser: "", type: "direct", fromLink: true });
      }
      if (!fresh.length) return;
      nodesRef.current = [...nodesRef.current, ...placeChildren(node, fresh)];
    };
    const takeTitle = (title) => {
      if (node.type === "root" && title && !node.titled) {
        node.label = title;
        node.titled = true;
      }
    };

    try {
      let first = true;
      const finalText = await fetchArticleTextStreaming(
        node.label,
        path,
        (partial) => {
          const { title, body } = splitTitleLine(partial);
          takeTitle(title);
          if (!body) {
            if (title) setNodes([...nodesRef.current]);
            return;
          }
          if (first) {
            node.articleLoading = false;
            node.articleStreaming = true;
            first = false;
          }
          addLinkChildren(body);
          setNodes([...nodesRef.current]);
          reveal.push(body);
        },
        node.newsContext,
        node.type,
        articleCacheKey,
        nodeCacheKey,
        (usage) => {
          nodeUsage = usage;
        },
        node.type === "root" ? node.heroSource || undefined : undefined
      );
      const { title, body: rawBody } = splitTitleLine(finalText);
      const finalBody = trimToLastSentence(rawBody);
      // What gets cached is the trimmed text, title line included for a
      // topic page, so later visitors get the same clean ending.
      const cacheText = title ? `TITLE: ${title}\n\n${finalBody}` : finalBody;
      takeTitle(title);
      addLinkChildren(finalBody);
      // Chips start the moment the article's text is in hand — not after
      // the typing animation catches up — with this article's own links
      // already known, so they're excluded.
      if (!trialExhaustedRef.current && !node.generated && !node.loading) expandNode(node.id, stripMarkdown(finalBody));
      await reveal.finish(finalBody);
      node.article = stripMarkdown(cleanStrayBrackets(finalBody));
      node.articleStreaming = false;
      node.articleLoading = false;
      if (articleCacheKey) writeNewsArticleCache(articleCacheKey, cacheText, nodeUsage, node.label);
      if (nodeCacheKey) writeNodeArticleCache(nodeCacheKey, cacheText, nodeUsage);
      if (node.type === "root" && !node.resumed) {
        recordRoot(node);
        // Reddit Ads conversion tracking — the first successful topic page
        // in a session is the real engagement signal for this campaign.
        maybeReportLead(user?.email);
      }
    } catch (e) {
      console.error("Hyfax: loadArticle failed", e);
      reveal.cancel();
      node.articleLoading = false;
      node.articleStreaming = false;
      node.article = null;
      node.articleError = e.message || "Couldn't load more — try again.";
    }
    syncActionsToday();
    setNodes([...nodesRef.current]);
  };

  // "Dig deeper" — capped to one extra round per node (the `deepened` flag
  // below), reusing the same streaming cursor UI as the initial load by
  // appending onto the existing text rather than replacing it. Unlike a
  // failed initial load (which has nothing worth keeping), a failed
  // continuation reverts to the article as it was before the attempt
  // rather than destroying content that was already there and working.
  const deepenArticle = async (nodeId) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node || !node.article || node.deepened || node.articleLoading || node.articleStreaming) return;
    const baseArticle = node.article;
    node.articleStreaming = true;
    node.deepenError = null;
    setNodes([...nodesRef.current]);

    const path = pathToNode(node);
    const reveal = createPacedReveal((revealed) => {
      node.article = `${baseArticle}\n\n${stripMarkdown(revealed)}`;
      setNodes([...nodesRef.current]);
    });
    try {
      const finalText = await fetchArticleContinuationStreaming(
        node.label,
        path,
        stripLinkMarkers(baseArticle),
        (partial) => {
          reveal.push(partial);
        },
        node.type
      );
      const trimmed = trimToLastSentence(finalText);
      await reveal.finish(trimmed);
      node.article = `${baseArticle}\n\n${stripMarkdown(trimmed)}`;
      node.articleStreaming = false;
      node.deepened = true;
    } catch (e) {
      console.error("Hyfax: deepenArticle failed", e);
      reveal.cancel();
      node.article = baseArticle;
      node.articleStreaming = false;
      node.deepenError = e.message || "Couldn't dig deeper — try again.";
    }
    syncActionsToday();
    setNodes([...nodesRef.current]);
  };

  // Selecting anything — a chip, a breadcrumb segment, an in-text link, or
  // a freshly submitted topic — starts its article immediately, then
  // generates its chips once the article is done. The article no longer
  // waits on the chips: it marks its own direct threads inline as [[links]],
  // and the chips (indirect/tangent leaps) are generated afterwards with
  // those links excluded — invisible to the reader, who is busy reading.
  useEffect(() => {
    if (!selectedId) return;
    const node = nodesRef.current.find((n) => n.id === selectedId);
    if (!node) return;

    // Once the trial's exhausted, don't even attempt an expand or a child's
    // article call — those are guaranteed to be rejected server-side. The
    // one exception is a topic page's OWN article: the server exempts that
    // call specifically (see rabbit-hole-proxy's isRootArticle) so a fresh
    // Dig In always gets a full standalone page — it just can't be branched
    // into any further.
    if (trialExhausted && node.type !== "root") return;

    // loadArticle starts the chips itself once its text has arrived; this
    // only covers revisiting a page whose chips never landed.
    if (!node.article && !node.articleLoading) {
      loadArticle(selectedId);
    } else if (node.article && !node.generated && !node.loading && !trialExhausted) {
      expandNode(selectedId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, trialExhausted]);

  const reset = () => {
    nodesRef.current = [];
    setNodes([]);
    setSelectedId(null);
    setTopic("");
    setInputVal("");
    setRootError(null);
    idCounter = 0;
  };

  // The one place every chip/in-text-link/Explore-next tap funnels
  // through — deliberately NOT called by startTopic/resumeExploredRoot
  // (a fresh root doesn't count as a "tap" for the Adoption funnel's
  // Activated stage, since starting any topic at all is nearly
  // universal; a root's own article view still counts, server-side, via
  // article_view).
  const jumpToNode = (nodeId) => {
    setSelectedId(nodeId);
    const node = nodesRef.current.find((n) => n.id === nodeId);
    const { sessionId } = touchSession();
    trackEvent("tap", { page: node?.label, sessionId });
  };

  // Word-of-mouth growth tool — snapshots the currently-open article to a
  // public, no-signin-required link (see lib/share.js) and either hands it
  // to the OS share sheet on mobile or copies it to the clipboard on
  // desktop, whichever the platform actually supports.
  const handleShare = async (node) => {
    if (!node || shareStatus === "sharing") return;
    setShareStatus("sharing");
    try {
      const url = await shareArticle({
        topicLabel: node.label,
        nodeType: node.type,
        overview: node.type === "root" ? node.overview || node.teaser : node.teaser,
        article: stripLinkMarkers(node.article || ""),
      });
      if (navigator.share) {
        await navigator.share({ title: node.label, text: "Follow this thread on Hyfax", url });
        setShareStatus("idle");
      } else {
        await navigator.clipboard.writeText(url);
        setShareStatus("copied");
        setTimeout(() => setShareStatus("idle"), 2000);
      }
    } catch (e) {
      // navigator.share throws when the user just cancels the OS share
      // sheet — that's not a failure worth surfacing as an error.
      if (e?.name === "AbortError") {
        setShareStatus("idle");
        return;
      }
      console.error("Hyfax: share failed", e);
      setShareStatus("error");
      setTimeout(() => setShareStatus("idle"), 2000);
    }
  };

  // Turns a highlighted word or phrase from the article into a new node —
  // same underlying mechanism the typed "explore your own thread" input
  // used to use, just triggered by a native text selection instead of
  // typing. Clears the browser's own selection afterward so the
  // highlight doesn't linger once you've already navigated away from it.
  const exploreSelection = () => {
    if (!selectionInfo) return;
    const parent = nodesRef.current.find((n) => n.id === selectedId);
    const text = selectionInfo.text;
    if (!parent || !text) return;
    const label = text.length > 60 ? text.slice(0, 59) + "…" : text;
    const [child] = placeChildren(parent, [{ label, teaser: "", type: "custom" }]);
    const newNodes = [...nodesRef.current, child];
    nodesRef.current = newNodes;
    setNodes(newNodes);
    setSelectionInfo(null);
    window.getSelection().removeAllRanges();
    jumpToNode(child.id);
  };

  // [[links]] the article marked itself render first; any remaining text
  // still gets exact-name matching against the node's children, which is
  // what links topics cached before inline links existed. A [[ that hasn't
  // closed yet (mid-stream) is held back rather than shown as raw brackets.
  // With no linkable children (trial exhausted), markers render as plain
  // text.
  const renderLinked = (rawText, children, articleHasMarkers = false) => {
    let text = rawText || "";
    const open = text.lastIndexOf("[[");
    if (open !== -1 && text.length - open < 60 && text.indexOf("]]", open) === -1) text = text.slice(0, open);
    const byLabel = new Map((children || []).map((c) => [c.label.toLowerCase(), c]));
    // Plain-name matching is only for chips in pre-[[link]] cached articles
    // (how those got their links). A [[link]] article links only what it
    // marked, once, so a pinned card it also names stays a card.
    const chipsOnly = articleHasMarkers ? [] : (children || []).filter((c) => !c.fromLink);
    const pieces = [];
    let last = 0;
    for (const m of text.matchAll(LINK_MARKER_RE)) {
      if (m.index > last) pieces.push(...linkifyText(text.slice(last, m.index), chipsOnly));
      const child = byLabel.get(toLinkLabel(m[1]).toLowerCase());
      pieces.push(child ? { type: "link", label: m[1], nodeId: child.id } : m[1]);
      last = m.index + m[0].length;
    }
    if (last < text.length) pieces.push(...linkifyText(text.slice(last), chipsOnly));
    return pieces.map((piece, i) =>
      typeof piece === "string" ? (
        <span key={i}>{piece}</span>
      ) : (
        <button
          key={i}
          onClick={() => jumpToNode(piece.nodeId)}
          data-precompute="thread"
          className="rh-link-accent"
          style={{ color: "#E3A73C", fontWeight: 500, textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: "2px" }}
        >
          {piece.label}
        </button>
      )
    );
  };

  const hasStarted = nodes.length > 0;
  // Distinct from hasStarted: flips true the instant "Dig in" is tapped, so
  // the page switches away from the hero the moment a topic is submitted
  // rather than waiting for the root's data to come back — the opening
  // sentence generates on the topic page itself, not on the hero page.
  const showTopicPage = hasStarted || rootLoading;
  const newsTopics = latestByField(trendingTopics, NEWS_FIELDS);
  const todayTopics = latestByField(trendingTopics, SPECIAL_FIELDS);
  const quoteTopic = latestByField(trendingTopics, [QUOTE_FIELD])[0] || null;
  const riddleTopic = previewRiddle || latestByField(trendingTopics, [RIDDLE_FIELD])[0] || null;
  const perspectiveTopic = latestByField(trendingTopics, [PERSPECTIVE_FIELD])[0] || null;
  // Shuffled once per riddle (not per render) so the answer isn't always
  // in the same slot but also doesn't jump around while someone's staring
  // at it deciding.
  const riddleChoices = useMemo(() => {
    if (!riddleTopic) return [];
    const decoys = Array.isArray(riddleTopic.options) ? riddleTopic.options : [];
    const all = [riddleTopic.topic, ...decoys];
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riddleTopic?.topic, riddleTopic?.options?.join("|")]);
  // A fresh riddle (new day) should start with a clean slate, not carry
  // over yesterday's wrong guesses or highlight state.
  useEffect(() => {
    setRiddleWrongPicks([]);
    setSelectedRiddle(false);
  }, [riddleTopic?.topic]);
  const selected = nodes.find((n) => n.id === selectedId) || null;

  // Smooth "opener sentence" transition-out once its article starts being
  // written — see the overview/teaser paragraph below. `overviewFading`
  // drives a real CSS opacity/transform transition instead of an instant
  // conditional swap, which read as sudden/jerky; `overviewGone` only flips
  // true once that transition has actually had time to play, so the
  // paragraph doesn't just disappear the instant it starts fading.
  const OVERVIEW_FADE_MS = 450;
  // Floor on how long the opening line stays fully visible before it's
  // allowed to start fading, measured from the moment it first appeared —
  // NOT from when the article finishes. Fading used to wait for the whole
  // article to finish generating, which for a fresh (non-cached) topic
  // happened to double as reading time for free; a CACHED article (see
  // node_cache/news_root_cache — the whole Reddit-campaign point) or an
  // already-typed-out child teaser (see the selection effect above, which
  // now waits for the teaser's own reveal before even starting the
  // article) arrives fast enough that without this floor the opening line
  // could start collapsing well before, or barely after, it finished
  // appearing.
  const OVERVIEW_MIN_VISIBLE_MS = 2500;
  const [overviewFading, setOverviewFading] = useState(false);
  const [overviewGone, setOverviewGone] = useState(false);
  const overviewShownAtRef = useRef(0);
  useEffect(() => {
    overviewShownAtRef.current = Date.now();
    setOverviewFading(false);
    setOverviewGone(false);
  }, [selected?.id]);
  // Starts the fade once the article is actually being written (streaming
  // in, or already fully there for an edge case that skips the streaming
  // flag) rather than waiting for it to finish — confirmed live that
  // waiting for full completion left the opening line sitting untouched,
  // fully redundant, for as long as the whole rest of the article took to
  // generate. `OVERVIEW_MIN_VISIBLE_MS` still protects a root's overview
  // (which has no equivalent of the child teaser's own pre-article delay)
  // from fading before there's been real time to read it.
  useEffect(() => {
    if ((selected?.articleStreaming || selected?.article) && !overviewGone && !overviewFading) {
      const elapsed = Date.now() - overviewShownAtRef.current;
      const wait = Math.max(0, OVERVIEW_MIN_VISIBLE_MS - elapsed);
      const startTimer = setTimeout(() => setOverviewFading(true), wait);
      return () => clearTimeout(startTimer);
    }
  }, [selected?.articleStreaming, selected?.article, overviewGone, overviewFading]);
  useEffect(() => {
    if (overviewFading && !overviewGone) {
      const fadeTimer = setTimeout(() => setOverviewGone(true), OVERVIEW_FADE_MS);
      return () => clearTimeout(fadeTimer);
    }
  }, [overviewFading, overviewGone]);
  const selectedChildren = selected ? nodes.filter((n) => n.parentId === selected.id) : [];
  // Inline [[link]] pages live in the article text; the chip row is only
  // the indirect/tangent threads generated after it.
  const chipChildren = selectedChildren.filter((n) => !n.fromLink);
  // Once the trial's exhausted, Dig In still works for a fresh general
  // topic, but nothing it produces should offer a further hyperlink to
  // dig into — passing an empty list here means renderLinked below just
  // renders plain text instead of clickable child names.
  const linkableChildren = trialExhausted ? [] : selectedChildren;

  // The free-limit offer. A visitor without an account is offered a free
  // one (more pages a day), and their thread is saved so the sign-in link
  // brings them back to this page; an account at its limit is offered
  // funds instead.
  const signUpAtLimit = () => {
    savePendingThread(nodesRef.current, selectedIdRef.current, topic);
    openAccountModal();
  };
  // Styled like the house ads (AdCard) so it reads as an offer, not as
  // more article text.
  const renderLimitCard = (onHero) => (
    <div className="rounded-2xl p-4 flex gap-3 items-start text-left" style={{ backgroundColor: "#6E4A2C" }}>
      <div
        className="shrink-0 flex items-center justify-center rounded-xl"
        style={{ width: "44px", height: "44px", backgroundColor: "#14100C" }}
      >
        <img src="/hyfax-logo.png" alt="" className="w-7 h-auto" />
      </div>
      <div className="rh-display">
        <div className="text-base mb-1" style={{ color: "#E3A73C", fontWeight: 700 }}>
          {user ? "You've read today's free pages" : "Sign up free to keep going"}
        </div>
        <p className="text-sm leading-relaxed mb-3" style={{ color: "#FFFFFF" }}>
          {user
            ? `Your ${trialStatus.searchLimit} free pages reset at 3am your time. Add funds for full access now.`
            : `You've read today's ${trialStatus.searchLimit} free pages. Sign up free for ${SIGNED_IN_PAGE_LIMIT} more today${
                onHero ? "." : ", and we'll bring you right back to this page."
              }`}
          {onHero ? " New topics and today's picks still open any time." : ""}
        </p>
        <button
          type="button"
          onClick={user ? openAccountModal : signUpAtLimit}
          className="inline-flex items-center gap-1 text-sm font-semibold rounded-full px-4 py-2"
          style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
        >
          {user ? "Add funds" : "Sign up free"}
          <ArrowUpRight size={14} />
        </button>
      </div>
    </div>
  );
  const breadcrumb = selected ? nodePathToRoot(selected) : [];

  return (
    <div className="w-full flex flex-col rh-body" style={{ backgroundColor: "#14100C", height: viewportH }}>
      <style>{`
        /* Fraunces requested WITHOUT the opsz (optical size) axis range —
           with it, some Android renderers interpolate the italic instance
           incorrectly at large sizes and flip specific glyphs (f, t)
           upside down. Fixed static optical size avoids the bad
           interpolation entirely. */
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;1,500&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
        .rh-display { font-family: 'Fraunces', serif; }
        .rh-body { font-family: 'Inter', sans-serif; }
        .rh-mono { font-family: 'JetBrains Mono', monospace; }
        .rh-fade-in { animation: rh-fadein 0.4s ease both; }
        @keyframes rh-fadein { from { opacity: 0; transform: translateY(6px);} to { opacity: 1; transform: translateY(0);} }
        .rh-chip-stagger-in { animation: rh-chip-stagger 0.35s ease both; }
        @keyframes rh-chip-stagger { from { opacity: 0; transform: translateY(4px) scale(0.96);} to { opacity: 1; transform: translateY(0) scale(1);} }
        .rh-placeholder::placeholder { color: #6B5B45; }
        .rh-input:focus { border-color: #E3A73C !important; }
        .rh-btn-dark:hover { background-color: #2A2018 !important; }
        .rh-btn-accent:hover { background-color: #EDB94F !important; }
        .rh-btn-outline:hover { border-color: #E3A73C !important; color: #F1E6D3 !important; }
        .rh-link-accent:hover { color: #EDB94F !important; }
        .rh-logo-btn { transition: opacity 0.15s; }
        .rh-logo-btn:hover { opacity: 0.8; }
        .rh-chip:hover { filter: brightness(1.15); }
        .rh-thread-card { transition: border-color 0.15s, background-color 0.15s, transform 0.1s; }
        .rh-thread-card:hover { border-color: #E3A73C !important; background-color: #2A2015 !important; }
        .rh-thread-card:active { transform: scale(0.99); }
        /* A slow sideways nudge on the first unread thread's arrow — a
           "this way" cue that stops once that thread has been opened. */
        @keyframes rh-nudge { 0%, 70%, 100% { transform: translateX(0); } 80% { transform: translateX(3px); } 90% { transform: translateX(0); } 95% { transform: translateX(2px); } }
        .rh-nudge { animation: rh-nudge 2.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .rh-nudge { animation: none; } }
        .rh-crumb:hover { color: #EDB94F !important; }
        .rh-text-10 { font-size: 10px; }
        .rh-tracking-30 { letter-spacing: 0.3em; }
        .rh-tracking-25 { letter-spacing: 0.25em; }
        /* One step below article titles (text-3xl). */
        .rh-hero-headline { font-size: 1.5rem; line-height: 1.25; }
        @keyframes rh-riddle-shake { 0%, 100% { transform: translateX(0); } 20%, 60% { transform: translateX(-6px); } 40%, 80% { transform: translateX(6px); } }
        .rh-riddle-shake { animation: rh-riddle-shake 0.4s ease-in-out; }
        @keyframes rh-blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0; } }
        .rh-cursor-blink { display: inline-block; animation: rh-blink 1s step-end infinite; margin-left: 1px; }
        /* Hides the native up/down stepper on number inputs (e.g. the
           account modal's top-up amount field) — cross-browser needs both
           rules since Chrome/Safari/Edge and Firefox expose it differently. */
        .rh-no-spinner::-webkit-outer-spin-button,
        .rh-no-spinner::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .rh-no-spinner { -moz-appearance: textfield; }
      `}</style>

      {/* header — always present, avatar always top-right. The thought
          count and free-search gauge used to also live in this same
          cramped right-hand column, which wrapped and collided with the
          centered logo/tagline on narrow phones — moved to their own
          full-width row below instead, where there's actually room. */}
      <div className="grid grid-cols-3 items-start p-5 md:p-7 shrink-0 max-w-4xl mx-auto w-full">
        <div />
        <div className="flex flex-col items-center text-center">
          <h1 className="flex items-center">
            <button
              type="button"
              onClick={reset}
              aria-label="Back to home"
              className="flex items-center rh-logo-btn"
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
            >
              <img src="/hyfax-logo.png" alt="Hyfax" className="h-8 md:h-10 w-auto" />
            </button>
          </h1>
          <div className="rh-mono rh-text-10 rh-tracking-25 uppercase mt-1 whitespace-nowrap" style={{ color: "#A89478" }}>
            thinking with threads
          </div>
        </div>
        <div className="flex justify-end">
          <AccountMenu
            user={user}
            profile={profile}
            onProfileChange={setProfile}
            onProfileRefresh={refreshProfile}
            onLifetimeFundedRefresh={refreshLifetimeFunded}
            onOpenLegal={setLegalDoc}
            openSignal={accountModalSignal}
          />
        </div>
      </div>

      {(hasStarted || !funded) && (
        <div className="flex items-center justify-center gap-5 px-5 pb-4 -mt-2 shrink-0 flex-wrap max-w-4xl mx-auto w-full">
          {hasStarted && (
            <div className="rh-mono rh-text-10 whitespace-nowrap" style={{ color: "#A89478" }}>
              {nodes.length} thought{nodes.length === 1 ? "" : "s"} uncovered
            </div>
          )}
          {/* Real free-trial status (production punch list, Section B) —
              same gauge treatment as the funded UsageGauge, just measuring
              free searches used against today's limit instead of dollars
              spent against lifetime funded. Funded accounts aren't limited
              by this at all, so nothing to show them here. */}
          {!funded && (
            <div style={{ width: "150px" }}>
              <MiniGauge
                label="Free searches today"
                valueText={`${trialStatus.searchesUsed}/${trialStatus.searchLimit}`}
                fraction={trialStatus.searchLimit ? trialStatus.searchesUsed / trialStatus.searchLimit : 0}
              />
            </div>
          )}
        </div>
      )}

      {!showTopicPage && (
        <div ref={heroRef} className="flex-1 flex flex-col items-center px-6 pt-10 md:pt-16 pb-10 overflow-y-auto">
          <div className="max-w-md w-full text-center rh-fade-in">
            {/* The brand's main line — home screen only. Each sentence
                stays whole, so a narrow screen breaks after "linear." */}
            <h2 className="rh-display rh-hero-headline italic mb-8" style={{ color: "#F1E6D3" }}>
              <span className="whitespace-nowrap">Problem solving isn't linear.</span>{" "}
              <span className="whitespace-nowrap">Neither is your learning.</span>
            </h2>

            {/* "Spin a thread" — a free, instant reroll through a fixed
                curated list (see lib/surpriseTopics.js), populating the
                input below rather than a separate lookalike box. Nothing
                committed until "Dig In" is actually tapped, so the reader
                can skip past as many boring picks as they want for free;
                only the one they accept ever costs a real generation or
                counts as a search. Takes the one-tap starter chips' old
                spot above the input — it's the same "instant, no-typing
                way in" role those played — and takes their gold accent
                treatment too, so it reads as the inviting entry point;
                "Dig In" (still the actual commit action, whether the input
                holds a spun pick or something typed) drops to the plainer
                outline instead. Hidden once a real Dig In is in flight,
                same as every other hero-page entry point. */}
            {!rootLoading && (
              <div className="flex justify-center mb-4">
                <button
                  type="button"
                  onClick={() => {
                    setInputVal(nextSurpriseTopic());
                    setIsSurprise(true);
                  }}
                  className="rh-body flex items-center gap-1.5 text-sm font-medium rounded-full px-5 py-3 transition-colors rh-btn-accent"
                  style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
                >
                  <Shuffle size={15} /> {isSurprise ? "Spin again" : "Spin a thread"}
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-2">
              <input
                value={inputVal}
                onChange={(e) => {
                  setInputVal(e.target.value);
                  setIsSurprise(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleStartClick();
                  }
                }}
                placeholder="What's on your mind?"
                disabled={rootLoading}
                className="rh-body flex-1 min-w-[180px] border outline-none rh-placeholder rh-input text-sm rounded-full px-5 py-3 transition-colors"
                style={{ backgroundColor: "#332617", borderColor: "#5A4630", color: "#F1E6D3" }}
              />
              <button
                type="button"
                onClick={handleStartClick}
                disabled={rootLoading}
                className="rh-body flex items-center gap-1.5 disabled:cursor-not-allowed text-sm font-medium rounded-full px-5 py-3 border transition-colors shrink-0 rh-btn-outline"
                style={{ backgroundColor: "transparent", borderColor: "#5A4630", color: "#C9B896" }}
              >
                {rootLoading ? (
                  <>
                    <Loader2 size={15} className="animate-spin" /> Digging in…
                  </>
                ) : (
                  <>
                    <Sparkles size={15} /> Dig in
                  </>
                )}
              </button>
            </div>

            <UsageGauge profile={profile} lifetimeFunded={lifetimeFunded} />

            {rootError && (
              <div className="mt-4 flex items-center justify-center gap-1.5 text-xs rh-body" style={{ color: "#D98A6E" }}>
                <AlertCircle size={13} /> {rootError}
              </div>
            )}

            {/* Browser-local "continue exploring" hook (see
                lib/exploredHistory.js) — resurfaces topics already dug
                into on this device so a returning visitor lands back in
                their own thread instead of a generic news wall. Not
                gated by trialExhausted/funded at all: resuming costs
                nothing (no network call, no trial-search count), so it
                stays available exactly when everything else might not. */}
            {/* Temporarily hidden to make hero-page room for the Surprise
                Me redesign — data/logic (exploredHistory, resumeExploredRoot)
                left fully intact, this is a display-only toggle. */}
            {false && exploredHistory.length > 0 && (
              <div className="mt-6 max-w-md mx-auto">
                <div className="rh-mono uppercase tracking-wider mb-2" style={{ fontSize: "9px", color: "#8A7F6C" }}>
                  Continue exploring
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {exploredHistory.map((entry) => (
                    <button
                      key={entry.label}
                      type="button"
                      onClick={() => resumeExploredRoot(entry)}
                      disabled={rootLoading}
                      className={`rh-chip rh-body text-xs rounded-full px-2.5 py-1 border transition-colors ${rootLoading ? "opacity-40" : ""}`}
                      style={{ borderColor: "#3A2E20", color: "#8A7F6C", backgroundColor: "transparent" }}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Quote Of The Day — same source table/cron cadence as "Today"
                (see promptForField in generate-trending-topics), but placed
                above "Trending" as its own section rather than grouped into
                the "Today" list, since a full quote needs more visual room
                than a short topic label + teaser. Reuses the "Today"
                feature toggle for gating (todayVisible) rather than adding
                a whole new toggle for one field. Clickable the same way as
                every other card — the quote text itself becomes the topic
                dug into, with the author/context teaser passed through as
                newsContext so the resulting article covers the quote's
                real history, significance, and author (see ARTICLE_TASK's
                dedicated Quote Of The Day guidance in hyfaxSystemPrompt.js). */}
            {quoteTopic && todayVisible && (
              <div className="mt-10">
                {/* Date badge — moved here from the top of "Trending" so
                    the whole hero batch's freshness reads once, up front,
                    rather than being tucked under one specific section.
                    Uses the most recent publish across the whole fetched
                    batch (trendingTopics), not just newsTopics, since every
                    field now refreshes together on the same once-daily cron. */}
                <div className="rh-mono text-lg font-semibold mb-2" style={{ color: "#E3A73C" }}>
                  {mostRecentDate(trendingTopics).toLocaleDateString(undefined, {
                    month: "long",
                    day: "numeric",
                  })}
                </div>
                <div className="flex items-center justify-center gap-1.5 mb-6">
                  <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
                    Quote of the Day
                  </span>
                </div>
                <div className="max-w-md mx-auto">
                  <button
                    data-precompute="hero"
                    type="button"
                    onClick={() => {
                      setSelectedQuote(true);
                      setSelectedNewsIdx(null);
                      setSelectedTodayIdx(null);
                      setSelectedPerspective(false);
                      startTopic(quoteTopic.topic, quoteTopic.teaser, QUOTE_FIELD);
                    }}
                    disabled={rootLoading}
                    className={`rh-chip text-left p-5 rounded-2xl border transition-colors w-full ${
                      rootLoading && !selectedQuote ? "opacity-40" : ""
                    } ${rootLoading && selectedQuote ? "cursor-default" : ""}`}
                    style={{
                      borderColor: selectedQuote ? "#E3A73C" : "#4A3826",
                      backgroundColor: selectedQuote ? "#2A2015" : "#241B12",
                    }}
                  >
                    <div className="rh-display italic text-xl leading-snug" style={{ color: "#F1E6D3" }}>
                      {quoteTopic.topic}
                    </div>
                    <p className="rh-body text-sm mt-3" style={{ color: "#B8A886" }}>
                      {quoteTopic.teaser}
                    </p>
                  </button>
                </div>
              </div>
            )}

            {/* "Today" — This Day In History + Word Of The Day, same
                source table and card treatment as "Trending"
                but date-anchored/evergreen rather than searched-for-recency.
                See promptForField in supabase/functions/generate-trending-topics.
                Same funded-only gate as "Trending" below. */}
            {todayTopics.length > 0 && todayVisible && (
              <div className="mt-10">
                <div className="flex items-center justify-center gap-1.5 mb-6">
                  <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
                    Today
                  </span>
                </div>
                <div className="flex flex-col gap-3 max-w-md mx-auto">
                  {todayTopics.map((t, i) => {
                    const isSelected = selectedTodayIdx === i;
                    return (
                      <button
                        data-precompute="hero"
                        key={`${t.field}-${i}`}
                        type="button"
                        onClick={() => {
                          setSelectedTodayIdx(i);
                          setSelectedNewsIdx(null);
                          setSelectedQuote(false);
                          setSelectedPerspective(false);
                          startTopic(t.topic, t.teaser, t.field);
                        }}
                        disabled={rootLoading}
                        className={`rh-chip text-left p-4 rounded-2xl border transition-colors ${
                          rootLoading && !isSelected ? "opacity-40" : ""
                        } ${rootLoading && isSelected ? "cursor-default" : ""}`}
                        style={{
                          borderColor: isSelected ? "#E3A73C" : "#4A3826",
                          backgroundColor: isSelected ? "#2A2015" : "#241B12",
                        }}
                      >
                        <span className="rh-mono text-xs uppercase tracking-wider font-semibold" style={{ color: "#E3A73C" }}>
                          {t.field}
                        </span>
                        <div className="rh-body text-lg font-semibold mt-1" style={{ color: "#F1E6D3" }}>
                          {t.topic}
                        </div>
                        <p className="rh-body text-sm mt-1" style={{ color: "#B8A886" }}>
                          {t.teaser}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* "Perspective" — same source table/cron cadence as "Today,"
                but its own dedicated single-item card rather than grouped
                into that list, same reasoning as Quote Of The Day/Riddle
                above. Reframes one specific thing by shifting scale (zoom
                in to the microscopic, or out to the cosmic) instead of
                searching for recency — see perspectivePrompt in
                generate-trending-topics. Rotates through a fixed
                Human/Nature/Space sequence server-side (one per day, not
                model-chosen — see nextPerspectiveFocus). Unlike Riddle/
                Quote, this field's category (the Human/Nature/Space focus)
                and direction (micro/macro, see migration 0048) ARE shown
                here, in place of the badge just repeating the section
                header's own "Perspective" label right above it. Reuses the
                "Today" feature toggle (todayVisible) rather than adding a
                whole new one for a single field, same call Quote Of The
                Day already made. */}
            {perspectiveTopic && todayVisible && (
              <div className="mt-10">
                <div className="flex items-center justify-center gap-1.5 mb-6">
                  <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
                    Perspective
                  </span>
                </div>
                <div className="max-w-md mx-auto">
                  <button
                    data-precompute="hero"
                    type="button"
                    onClick={() => {
                      setSelectedPerspective(true);
                      setSelectedNewsIdx(null);
                      setSelectedTodayIdx(null);
                      setSelectedQuote(false);
                      startTopic(perspectiveTopic.topic, perspectiveTopic.teaser, PERSPECTIVE_FIELD);
                    }}
                    disabled={rootLoading}
                    className={`rh-chip text-left p-4 rounded-2xl border transition-colors w-full ${
                      rootLoading && !selectedPerspective ? "opacity-40" : ""
                    } ${rootLoading && selectedPerspective ? "cursor-default" : ""}`}
                    style={{
                      borderColor: selectedPerspective ? "#E3A73C" : "#4A3826",
                      backgroundColor: selectedPerspective ? "#2A2015" : "#241B12",
                    }}
                  >
                    <span className="rh-mono text-xs uppercase tracking-wider font-semibold" style={{ color: "#E3A73C" }}>
                      {[perspectiveTopic.category, perspectiveTopic.direction].filter(Boolean).join(" · ") || "Perspective"}
                    </span>
                    <div className="rh-body text-lg font-semibold mt-1" style={{ color: "#F1E6D3" }}>
                      {perspectiveTopic.topic}
                    </div>
                    <p className="rh-body text-sm mt-1" style={{ color: "#B8A886" }}>
                      {perspectiveTopic.teaser}
                    </p>
                  </button>
                </div>
              </div>
            )}

            {/* "Riddle me this...." — the branching mechanic run backwards:
                instead of a topic branching OUT into surprising tangents,
                this weaves the tangents into one withheld-register riddle
                first. Was a multiple-choice guess (real answer + 2 decoys)
                — that UI is hidden below, not deleted, per feedback that
                the guessing element wasn't landing — replaced with a plain
                "click to find out" reveal: the whole card IS the answer
                button now, same one-tap pattern as Quote Of The Day. Still
                a real billable Dig In on click, same as every other hero
                card. Has its own toggle (featureRiddle) rather than reusing
                "Today"'s, so a funded user can turn it off independently,
                same as every other à la carte feature. */}
            {/* The guessing game ("What am I?", see RiddleGame.jsx) for a
                riddle curated with game pieces; older riddles keep the
                one-tap card below. */}
            {riddleTopic && riddleVisible && riddleTopic.riddle_game && (
              <RiddleGame
                riddle={riddleTopic}
                user={user}
                onSignUp={openAccountModal}
                disabled={rootLoading}
                onOpenAnswer={() => {
                  setSelectedRiddle(true);
                  setSelectedNewsIdx(null);
                  setSelectedTodayIdx(null);
                  setSelectedQuote(false);
                  setSelectedPerspective(false);
                  // The answer page's threads are the clues just solved.
                  startTopic(
                    riddleTopic.topic,
                    riddleTopic.teaser,
                    RIDDLE_FIELD,
                    riddleTopic.riddle_game.clues.map((c, i) => ({
                      label: c.title,
                      teaser: c.teaser,
                      type: i < 2 ? "indirect" : "tangent",
                      pinned: true,
                    }))
                  );
                }}
              />
            )}
            {riddleTopic && riddleVisible && !riddleTopic.riddle_game && (
              <div className="mt-10">
                <div className="flex items-center justify-center gap-1.5 mb-6">
                  <HelpCircle size={14} style={{ color: "#C9B896" }} />
                  <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
                    Riddle me this....
                  </span>
                </div>
                <div className="max-w-md mx-auto">
                  <button
                    data-precompute="hero"
                    type="button"
                    onClick={() => {
                      setSelectedRiddle(true);
                      setSelectedNewsIdx(null);
                      setSelectedTodayIdx(null);
                      setSelectedQuote(false);
                      setSelectedPerspective(false);
                      startTopic(riddleTopic.topic, riddleTopic.teaser, RIDDLE_FIELD);
                    }}
                    disabled={rootLoading}
                    className={`rh-chip text-left p-5 rounded-2xl border transition-colors w-full ${
                      rootLoading && !selectedRiddle ? "opacity-40" : ""
                    } ${rootLoading && selectedRiddle ? "cursor-default" : ""}`}
                    style={{
                      borderColor: selectedRiddle ? "#E3A73C" : "#4A3826",
                      backgroundColor: selectedRiddle ? "#2A2015" : "#241B12",
                    }}
                  >
                    <p className="rh-display italic text-lg leading-relaxed" style={{ color: "#F1E6D3" }}>
                      {riddleTopic.teaser}
                    </p>
                  </button>
                </div>

                {/* Multiple-choice guess UI — hidden, not erased, in case
                    this comes back in a different form. */}
                {false && (
                  <div
                    className="max-w-md mx-auto mt-2 p-5 rounded-2xl border"
                    style={{ borderColor: "#4A3826", backgroundColor: "#241B12" }}
                  >
                    <div className="flex flex-col gap-2">
                      {riddleChoices.map((choice) => {
                        const isCorrectPick = selectedRiddle && choice === riddleTopic.topic;
                        const isWrong = riddleWrongPicks.includes(choice);
                        return (
                          <button
                            key={choice}
                            type="button"
                            onClick={() => {
                              if (choice === riddleTopic.topic) {
                                setSelectedRiddle(true);
                                setSelectedNewsIdx(null);
                                setSelectedTodayIdx(null);
                                setSelectedQuote(false);
                                setSelectedPerspective(false);
                                startTopic(riddleTopic.topic, riddleTopic.teaser, RIDDLE_FIELD);
                              } else {
                                setRiddleWrongPicks((prev) => (prev.includes(choice) ? prev : [...prev, choice]));
                              }
                            }}
                            disabled={rootLoading || isWrong}
                            className={`rh-chip rh-body text-sm text-left rounded-xl px-4 py-2.5 border transition-colors ${
                              rootLoading && !isCorrectPick ? "opacity-40" : ""
                            } ${rootLoading && isCorrectPick ? "cursor-default" : ""}`}
                            style={{
                              borderColor: isCorrectPick ? "#E3A73C" : "#5A4630",
                              backgroundColor: isCorrectPick ? "#2A2015" : "transparent",
                              color: isWrong ? "#6B5B45" : "#F1E6D3",
                              textDecoration: isWrong ? "line-through" : "none",
                            }}
                          >
                            {choice}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* House ad (Section H) — between "Reverse Hyfax" and
                "Trending", the same "not first, not last" depth it held in
                the previous section order. Funded accounts don't see ads at
                all — this is specifically aimed at engaging free/
                unsubscribed users, not a house ad slot everyone gets.
                Seeded off the browser's own session id, so it's stable for
                one visitor across a visit but varies visitor to visitor. */}
            {!funded && (
              <div className="mt-10">
                <AdCard ad={pickHouseAd(getSessionId(), adStage)} onClick={openAccountModal} />
              </div>
            )}

            {/* real, live-searched stories — see
                supabase/functions/generate-trending-topics. The "as of"
                date that used to live here moved to the top of the hero
                page, above "Quote of the Day" — see that section below.
                Hidden once the free trial's used up (production punch
                list, Section B) — Trending is a funded-only feature per
                the monetization outline's Section 14.1 feature matrix. */}
            {newsTopics.length > 0 && newsVisible && (
              <div className="mt-10">
                <div className="flex items-center justify-center gap-1.5 mb-6">
                  <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
                    Trending
                  </span>
                </div>
                <div className="flex flex-col gap-3 max-w-md mx-auto">
                  {newsTopics.map((t, i) => {
                    const isSelected = selectedNewsIdx === i;
                    return (
                      <button
                        data-precompute="hero"
                        key={`${t.field}-${i}`}
                        type="button"
                        onClick={() => {
                          setSelectedNewsIdx(i);
                          setSelectedTodayIdx(null);
                          setSelectedQuote(false);
                          setSelectedPerspective(false);
                          startTopic(t.topic, t.teaser, t.field);
                        }}
                        disabled={rootLoading}
                        className={`rh-chip text-left p-4 rounded-2xl border transition-colors ${
                          rootLoading && !isSelected ? "opacity-40" : ""
                        } ${rootLoading && isSelected ? "cursor-default" : ""}`}
                        style={{
                          borderColor: isSelected ? "#E3A73C" : "#4A3826",
                          backgroundColor: isSelected ? "#2A2015" : "#241B12",
                        }}
                      >
                        <span className="rh-mono text-xs uppercase tracking-wider font-semibold" style={{ color: "#E3A73C" }}>
                          {NEWS_FIELD_LABELS[t.field] || t.field}
                        </span>
                        <div className="rh-body text-lg font-semibold mt-1" style={{ color: "#F1E6D3" }}>
                          {t.topic}
                        </div>
                        <p className="rh-body text-sm mt-1" style={{ color: "#B8A886" }}>
                          {t.teaser}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Free trial used up (production punch list, Section B) — the
                "hero placement promoting the paid balance" the
                monetization outline's Section 14.1 calls for once the
                floor is hit. Billing (Section D) is live now, so this
                points at the real "Manage" > "Add funds" control in
                AccountMenu above instead of a dead-end CTA. */}
            {trialExhausted && <div className="mt-10">{renderLimitCard(true)}</div>}

            <div className="mt-10 flex items-center justify-center gap-4 rh-mono rh-text-10" style={{ color: "#5A4A38" }}>
              <button
                type="button"
                onClick={() => setLegalDoc("terms")}
                className="rh-link-accent transition-colors"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit" }}
              >
                Terms
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => setLegalDoc("privacy")}
                className="rh-link-accent transition-colors"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit" }}
              >
                Privacy
              </button>
            </div>
          </div>
        </div>
      )}

      {legalDoc && <LegalModal doc={legalDoc} onClose={() => setLegalDoc(null)} />}

      {/* Soft sign-up nudge — fixed bar, not a modal, so it never sits in
          front of the article or the chips it's specifically trying to get
          someone to keep exploring with. Dismiss just hides it (via
          lib/chipTaps.js) rather than signing anyone out of anything;
          "Sign up" opens the same account modal every other entry point
          in this app uses (openAccountModal). */}
      {showSignUpPrompt && (
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-full border px-4 py-2.5 shadow-lg rh-fade-in"
          style={{ backgroundColor: "#1F1811", borderColor: "#3A2E20" }}
        >
          <span className="rh-body text-sm" style={{ color: "#F1E6D3" }}>
            Want to keep your threads? Sign up.
          </span>
          <button
            type="button"
            onClick={() => {
              setShowSignUpPrompt(false);
              openAccountModal();
            }}
            className="rh-body text-xs font-medium rounded-full px-3 py-1.5 shrink-0"
            style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
          >
            Sign up
          </button>
          <button
            type="button"
            onClick={() => {
              dismissSignUpPrompt();
              setShowSignUpPrompt(false);
            }}
            className="rh-body text-xs shrink-0"
            style={{ color: "#6B5B45" }}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {hasStarted && selected && (
        <>
          <div ref={contentRef} className="flex-1 overflow-y-auto px-5 md:px-7 pb-10">
            <div className="max-w-2xl mx-auto rh-fade-in" key={selected.id}>
              <div className="flex items-center justify-between mb-3">
                <span
                  className="rh-mono rh-text-10 uppercase tracking-wider px-2 py-0.5 rounded-full inline-block"
                  style={{
                    color: TYPE_COLOR[selected.type] || "#E3A73C",
                    border: `1px solid ${TYPE_COLOR[selected.type] || "#E3A73C"}55`,
                  }}
                >
                  {selected.type === "root" ? "Origin" : TYPE_LABEL[selected.type]}
                </span>

                {selected.article && !selected.articleStreaming && (
                  <button
                    type="button"
                    onClick={() => handleShare(selected)}
                    disabled={shareStatus === "sharing"}
                    className="flex items-center gap-1.5 rh-mono rh-text-10 uppercase tracking-wider transition-colors disabled:opacity-50 rounded-full px-3 py-1.5 border font-semibold"
                    style={{
                      borderColor: shareStatus === "error" ? "#D98A6E" : "#E3A73C",
                      color: shareStatus === "error" ? "#D98A6E" : "#E3A73C",
                      backgroundColor: shareStatus === "copied" ? "#E3A73C22" : "transparent",
                    }}
                  >
                    {shareStatus === "copied" ? (
                      <>
                        <Check size={13} /> Link copied
                      </>
                    ) : shareStatus === "error" ? (
                      <>
                        <AlertCircle size={13} /> Couldn't share
                      </>
                    ) : (
                      <>
                        <Share2 size={13} /> Share
                      </>
                    )}
                  </button>
                )}
              </div>

              <h2 className="rh-display text-3xl italic mb-4" style={{ color: "#F1E6D3" }}>
                {selected.label}
              </h2>

              <div ref={articleTextRef} className="text-base leading-relaxed" style={{ color: "#F5EDDC" }}>
                {!overviewGone && (selected.type === "root" ? selected.overview || selected.teaser : selected.teaser) ? (
                  // Stays visible for as long as the article is generating
                  // (that's the point — a headline and an opening line to
                  // read while the rest streams in), then collapses away
                  // smoothly once the article is fully realized, since by
                  // then its own opening paragraph covers the same ground
                  // as this overview/teaser (confirmed live on a Word Of
                  // The Day page: both restated the same etymology back to
                  // back) and keeping it around any longer is pure repeat.
                  // A grid-rows collapse (rather than a plain fade) so the
                  // article's divider line rides up with it and settles
                  // right under the title, instead of just fading in place
                  // and leaving a gap behind — the "fr" trick animates to a
                  // true zero height without needing to measure the text.
                  <div
                    className="grid"
                    style={{
                      gridTemplateRows: overviewFading ? "0fr" : "1fr",
                      transition: `grid-template-rows ${OVERVIEW_FADE_MS}ms ease-in-out`,
                    }}
                  >
                    <div className="overflow-hidden">
                      <p
                        className="transition-opacity ease-out"
                        style={{ transitionDuration: `${OVERVIEW_FADE_MS}ms`, opacity: overviewFading ? 0 : 1 }}
                      >
                        {renderLinked(selected.type === "root" ? selected.overview || selected.teaser : selected.teaser, linkableChildren)}
                      </p>
                    </div>
                  </div>
                ) : null}

                {selected.article ? (
                  <div className="mt-4 pt-4 border-t space-y-4 rh-fade-in" style={{ borderColor: "#4A3C2C", color: "#F1E6D3" }}>
                    {selected.article
                      .split(/\n\s*\n/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                      .map((para, i, arr) => (
                        <Fragment key={i}>
                          <p>
                            {renderLinked(para, linkableChildren, (selected.article || "").includes("[["))}
                            {selected.articleStreaming && i === arr.length - 1 ? (
                              <span className="rh-cursor-blink" style={{ color: "#E3A73C" }}>
                                {"▌"}
                              </span>
                            ) : null}
                          </p>
                          {/* House ad (Section H) — one per article, funded
                              accounts don't see these at all. Seeded off the
                              node so the same node always shows the same ad
                              (no flicker on re-render) while different nodes
                              tend to show different ones. Sandwiched after
                              the first paragraph rather than sitting above
                              the article entirely. A second one shows after
                              "dig deeper" instead of repeating this same
                              slot twice.

                              The Reddit ad campaign's landing topic (see
                              migration 0039, currently "why does bread go
                              stale") pins this specific ad instead of
                              leaving it to rotation — a first-time visitor
                              from that campaign should see copy picked for
                              them, not whatever the seeded pick happens to
                              land on. Every other topic keeps the normal
                              rotation untouched. */}
                          {!funded && !selected.articleStreaming && i === 0 && arr.length > 1 && (
                            <AdCard
                              ad={
                                selected.type === "root" && selected.fullTopic === "why does bread go stale"
                                  ? getHouseAdById("what-are-you-looking-for")
                                  : pickHouseAd(selected.id, adStage)
                              }
                              onClick={openAccountModal}
                            />
                          )}
                        </Fragment>
                      ))}

                    {/* light-touch, not a primary action — this app is
                        entertainment, not a research tool, so this is
                        deliberately understated and capped to one extra
                        round (selected.deepened) rather than open-ended
                        pagination for the minority who want a bit more
                        before moving on */}
                    {!selected.articleStreaming && !selected.articleLoading && !selected.deepened && !trialExhausted && digDeeperVisible && (
                      <button
                        onClick={() => deepenArticle(selected.id)}
                        className="flex items-center gap-1.5 text-sm font-semibold transition-colors rh-link-accent"
                        style={{ color: "#E3A73C" }}
                      >
                        <ChevronDown size={15} /> Read more on this
                      </button>
                    )}
                    {selected.deepenError && (
                      <div className="flex items-center gap-1.5 text-sm" style={{ color: "#D98A6E" }}>
                        <AlertCircle size={13} /> {selected.deepenError}
                      </div>
                    )}
                    {/* Second house ad — funded accounts don't see these at
                        all (same as the first ad above). Only once "dig
                        deeper" content has actually landed, so a reader
                        gets one ad impression per article by default and a
                        second only if they asked for more. Different seed
                        than the first ad on this same node so the two
                        don't just repeat. */}
                    {!funded && selected.deepened && !selected.articleStreaming && (
                      <AdCard ad={pickHouseAd(`${selected.id}:deep`, adStage)} onClick={openAccountModal} />
                    )}
                  </div>
                ) : selected.articleLoading ? (
                  <div className="mt-4 flex items-center gap-1.5 text-base" style={{ color: "#B8A886" }}>
                    <Loader2 size={16} className="animate-spin" /> Digging in…
                  </div>
                ) : selected.articleError && !trialExhausted ? (
                  <div className="mt-4">
                    <button
                      onClick={() => loadArticle(selected.id)}
                      className="flex items-center gap-1.5 text-base font-medium transition-colors rh-link-accent"
                      style={{ color: "#E3A73C" }}
                    >
                      <BookOpen size={16} /> Try again
                    </button>
                    <div className="flex items-center gap-1.5 text-sm mt-2" style={{ color: "#D98A6E" }}>
                      <AlertCircle size={13} /> {selected.articleError}
                    </div>
                  </div>
                ) : null}

                {/* At the free limit: the sign-up (or add funds) offer, in
                    place of the error on a page the proxy refused, or of
                    the threads under a page that can't branch any further
                    for free. Shown once even when both the article and
                    chips calls were refused. */}
                {trialExhausted &&
                  (selected.error || selected.articleError || (selected.article && !selected.articleStreaming)) && (
                    <div className="mt-4">{renderLimitCard(false)}</div>
                  )}

                {selected.error && !trialExhausted && (
                  <div className="flex items-center gap-1.5 text-sm mt-3" style={{ color: "#D98A6E" }}>
                    <AlertCircle size={13} /> {selected.error}
                  </div>
                )}
                {selected.loading && (
                  <div className="flex items-center gap-1.5 text-base mt-3" style={{ color: "#B8A886" }}>
                    <Loader2 size={16} className="animate-spin" /> Finding more threads…
                  </div>
                )}
                {selected.error && !selected.loading && !trialExhausted && (
                  <button
                    onClick={() => expandNode(selected.id)}
                    className="mt-2 flex items-center gap-1.5 text-base font-medium transition-colors rh-link-accent"
                    style={{ color: "#E3A73C" }}
                  >
                    <ArrowUpRight size={14} /> Try again
                  </button>
                )}
              </div>

              {/* deliberately OUTSIDE articleTextRef — chip labels and the
                  reset button aren't article prose, and highlighting one of
                  them shouldn't be treated as "explore this word" the way
                  selecting actual article text is meant to be */}
              <div>
                {/* breadcrumb — every earlier stop is tappable, jumps
                    straight back with no need to retrace taps one at a
                    time. Sits right above "Explore next" now, inline, as a
                    "here's how you got here" just before "here's where you
                    can go" instead of pinned above the article itself. */}
                {/* Only once there's somewhere to go back to — on a topic's
                    own page it would just repeat the page's title. */}
                {breadcrumb.length > 1 && (
                <div className="flex items-center gap-1.5 flex-wrap rh-body text-xs mt-10 mb-4">
                  {breadcrumb.map((n, i) => (
                    <span key={n.id} className="flex items-center gap-1.5">
                      {i > 0 && <ChevronRight size={10} style={{ color: "#6B5B45" }} aria-hidden="true" />}
                      {i === breadcrumb.length - 1 ? (
                        <span style={{ color: "#F1E6D3", fontWeight: 500 }}>{n.label}</span>
                      ) : (
                        <button
                          onClick={() => jumpToNode(n.id)}
                          className="rh-crumb transition-colors"
                          style={{ color: "#A89478", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: "2px" }}
                        >
                          {n.label}
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                )}

                {/* explore next — full-width cards rather than small pills
                    so they read as the obvious next step: the thread's
                    name, its one-line teaser, and an arrow. Hidden once
                    the trial's exhausted — every one of these would be a
                    dead-end into content that's guaranteed to be rejected,
                    matching linkableChildren's same rule for in-text
                    links above. */}
                {!trialExhausted && chipChildren.length > 0 && (
                  <div className="mt-8">
                    <div className="flex items-baseline justify-between gap-3 mb-3">
                      <div className="rh-display text-xl italic" style={{ color: "#F1E6D3" }}>
                        Where to next?
                      </div>
                      <div className="rh-mono rh-text-10 uppercase tracking-wider" style={{ color: "#A89478" }}>
                        Tap a thread
                      </div>
                    </div>
                    <div className="flex flex-col gap-2.5">
                      {chipChildren.map((child, i) => {
                        const visited = !!child.article;
                        const firstFresh = !visited && chipChildren.findIndex((c) => !c.article) === i;
                        return (
                          <button
                            key={child.id}
                            onClick={() => {
                              jumpToNode(child.id);
                              if (!user && !hasDismissedSignUpPrompt() && recordChipTap() === 3) {
                                setShowSignUpPrompt(true);
                              }
                            }}
                            data-precompute="thread"
                            className="rh-chip rh-thread-card rh-chip-stagger-in w-full text-left rounded-2xl border px-4 py-3 flex items-center gap-3"
                            style={{
                              borderColor: visited ? "#4A3C2C" : "#E3A73C88",
                              backgroundColor: visited ? "#1A140E" : "#241B12",
                              // One at a time rather than all popping in
                              // together — see the ad brief's "reveal chips
                              // one at a time as they arrive" ask.
                              animationDelay: `${i * 90}ms`,
                            }}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="rh-body text-base font-semibold" style={{ color: visited ? "#B8A886" : "#F1E6D3" }}>
                                {child.label}
                              </div>
                              {child.teaser && (
                                <div className="rh-body text-sm mt-0.5 leading-snug" style={{ color: visited ? "#8A7A62" : "#B8A886" }}>
                                  {child.teaser}
                                </div>
                              )}
                            </div>
                            <span
                              className={`shrink-0 flex items-center justify-center rounded-full w-8 h-8 ${firstFresh ? "rh-nudge" : ""}`}
                              style={{ backgroundColor: visited ? "transparent" : "#E3A73C", color: visited ? "#8A7A62" : "#14100C" }}
                              aria-hidden="true"
                            >
                              {visited ? <Check size={16} /> : <ChevronRight size={18} />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="mt-6 pt-4 border-t" style={{ borderColor: "#4A3C2C" }}>
                  <button
                    onClick={reset}
                    className="flex items-center gap-1.5 rh-body text-xs border rounded-full px-3 py-1.5 transition-colors rh-btn-dark"
                    style={{ color: "#F1E6D3", backgroundColor: "#1F1811", borderColor: "#3A2E20" }}
                  >
                    <RotateCcw size={12} />
                    New thread
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* floats just BELOW whatever's currently highlighted in the article
          text, deliberately not above it — the browser's own native
          Copy/Look Up menu appears above a selection on most platforms, so
          sitting below avoids fighting that for the same space. Styled
          identically to the main "Dig in" button (same icon, same label,
          same color) rather than a differently-worded "Explore" affordance,
          so it reads as the same app action wherever it shows up instead of
          looking like a piece of browser UI. */}
      {selectionInfo && (
        <button
          type="button"
          onClick={exploreSelection}
          className="rh-body flex items-center gap-1.5 text-sm font-medium rounded-full px-5 py-3 transition-colors shadow-lg rh-btn-accent"
          style={{
            position: "fixed",
            top: selectionInfo.bottom + 14,
            left: selectionInfo.left,
            transform: "translateX(-50%)",
            backgroundColor: "#E3A73C",
            color: "#14100C",
            zIndex: 50,
            whiteSpace: "nowrap",
          }}
        >
          <Sparkles size={15} /> Dig in
        </button>
      )}
    </div>
  );
}
