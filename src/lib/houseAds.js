// House ads promoting Hyfax itself — learning, problem solving, planting
// ideas, and that it's free (production punch list, Section H) — replaces the third-party MOCK_SPONSOR placeholders
// in the hero and in-article ad slots. The "Explore next" chip ad is a
// separate, constant slot and stays out of this rotation (see App.jsx).
//
// Written by hand, not generated — this is the one file to edit to
// add/change an ad. Body is plain text with three lightweight inline
// markers, similar to markdown, so an ad's whole look lives in one
// string without touching any component code:
//   **text**  -> accent-gold color (the opening hook)
//   __text__  -> underlined
//   *text*    -> italic
// Anything else renders as normal body text. CTA is a separate field —
// it always renders as the gold link at the end of the card. See
// AdCard.jsx for the parser/renderer.
//
// Optional `stage` field: "early" | "mid" | "late" — lets an unsubscribed
// session see a different slice of the ads the longer it's stuck around
// (see engagementStage below), e.g. a soft/curious hook early on vs. a
// more direct subscribe pitch once someone's clearly engaged. An ad with
// no `stage` is eligible at every stage — leave it off for anything that
// isn't meant to escalate. Example:
//   { id: "example", body: "...", cta: "...", stage: "late" }
import { PAYMENTS_ENABLED } from "./billing.js";

export const HOUSE_ADS = [
  {
    id: "remember-when",
    body: "**Remember when learning felt like this?** Before tests, before deadlines — just you, one good question, and the itch to find out what's behind the next door. Hyfax brings that back. *Free, too.*",
    cta: "Let's go",
    stage: "early",
  },
  {
    id: "stuck-on-a-problem",
    body: "**Stuck on a problem?** The answer usually isn't further down the same road. It's sideways, in some field you'd never think to check. Hyfax walks you sideways on purpose. That's the whole trick.",
    cta: "Let's go",
    stage: "mid",
  },
  {
    id: "plant-one-question",
    body: "**Plant one question.** Water it with a few taps. Come back to find a whole tree of things you didn't know you wanted to know. Gardening for the brain, no green thumb required.",
    cta: "Let's go",
    stage: "early",
  },
  {
    // Says outright there's no paid tier, so it sits out if paid plans
    // come back (see pickHouseAd).
    id: "free-no-catch",
    body: "**Yes, it's free. No, there's no catch.** No card, no trial clock, no \"premium\" door slamming shut at page five. Make a free account and pull on as many threads as you like. *We'll wait.*",
    cta: "Let's go",
    stage: "late",
    freeOnly: true,
  },
  {
    id: "connect-the-dots",
    body: "**Every expert you admire has one thing in common.** They connect dots other people don't even see. Turns out that's a learnable skill — and Hyfax is where you practice it, one thread at a time.",
    cta: "Let's go",
    stage: "early",
  },
  {
    id: "five-minutes-a-day",
    body: "**Five minutes a day.** That's all it takes to plant a new idea in your head. Do it daily and you'll be the person with the oddly perfect fact for every conversation. Costs you nothing but curiosity.",
    cta: "Let's go",
    stage: "mid",
  },
];

// Pins one specific ad by id instead of rotating — used for the Reddit ad
// campaign's landing ("why does bread go stale", see App.jsx), where the copy was
// picked deliberately for a first-time visitor rather than left to whatever
// the normal seeded rotation happens to land on.
export function getHouseAdById(id) {
  return HOUSE_ADS.find((ad) => ad.id === id) || null;
}

// Deterministic pick — the same seed always returns the same ad (so a
// given node/session doesn't flicker between different ads on
// re-render), but different seeds spread across the list. Not true
// randomness and no impression tracking yet — simplest thing that
// actually rotates as people move between sessions and topics, worth
// revisiting once there's real click data to weight by (same pattern as
// the cost/latency work elsewhere in this app).
//
// `stage`, if passed, narrows the pool to ads tagged for that stage (plus
// any untagged ad, which is eligible everywhere) before picking — pass
// undefined/omit for a funded account, which isn't mid-conversion-funnel
// and just gets plain rotation across the whole list.
export function pickHouseAd(seed, stage) {
  // An ad that promises it's all free sits out if paid plans come back.
  const ads = PAYMENTS_ENABLED ? HOUSE_ADS.filter((ad) => !ad.freeOnly) : HOUSE_ADS;
  if (!ads.length) return null;
  const pool = stage ? ads.filter((ad) => !ad.stage || ad.stage === stage) : ads;
  const candidates = pool.length ? pool : ads; // fail open if a stage has nothing tagged yet
  let h = 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return candidates[h % candidates.length];
}

// "How engaged is this unsubscribed session" bucket, derived from the
// same free-trial numbers already shown in the header (X of Y searches
// used today) rather than a new tracked metric. Deliberately a fraction
// of the limit, not a hardcoded search count, so it keeps working if
// FREE_SEARCH_LIMIT (rabbit-hole-proxy) ever changes.
export function engagementStage({ searchesUsed, searchLimit }) {
  if (!searchLimit) return "early";
  const frac = searchesUsed / searchLimit;
  if (frac < 1 / 3) return "early";
  if (frac < 2 / 3) return "mid";
  return "late";
}
