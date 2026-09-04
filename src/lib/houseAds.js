// House ads promoting Hypha's own subscription/funding (production punch
// list, Section H) — replaces the third-party MOCK_SPONSOR placeholders
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
// session see a different slice of the 24 the longer it's stuck around
// (see engagementStage below), e.g. a soft/curious hook early on vs. a
// more direct subscribe pitch once someone's clearly engaged. An ad with
// no `stage` is eligible at every stage — leave it off for anything that
// isn't meant to escalate. Example:
//   { id: "example", body: "...", cta: "...", stage: "late" }
export const HOUSE_ADS = [
  {
    id: "death-scrolling",
    body: "**Death scrolling again?!** Come on. I get it, you got some __you-time__ finally, but replacing the social with Hyfa will give you that fresh feeling of knowledge rather than … well you know.",
    cta: "Let's go",
    stage: "early",
  },
  {
    id: "im-exhausted",
    body: "**I'm exhausted!!** I just went from learning about macadamia nuts to woodpecker toy physics to Black Monday in '87. What a long, strange trip it is.",
    cta: "Let's go",
    stage: "early",
  },
  {
    id: "great-bob",
    body: "**That is great, Bob.** But can you connect the origins of peaches in China to the design of the Apollo space suits, Bob? Get on Hyfa, and you will.l",
    cta: "Let's go",
    stage: "early",
  },
  {
    id: "do-you-want-to-join",
    body: "**So….do you want to join?** Sorry, my boss is making me ask. You know there is no commitment, time frame, or obligation. You control your knowledge destiny like the boss you are.",
    cta: "Let's go",
    stage: "mid",
  },
  {
    id: "just-saying",
    body: "**Just saying….** Give me ten fast ones, and you will not regret it, I promise. Each one of those hard-earned dollar bills will wait silently for you to use them… a month, a year…. Doesn't matter.",
    cta: "Let's go",
    stage: "mid",
  },
  {
    id: "does-money-buy-everything",
    body: "**Does money buy everything?** Obviously not, just the things that cost money. Speaking of money, your brain needs fuel and fuel costs money.",
    cta: "Let's go",
    stage: "mid",
  },
  {
    id: "do-or-die",
    body: "**It's do or die**. Okay, that was a little extreme, but your time is running thin. I don't want to start pulling functions, but a deal is a deal.",
    cta: "Let's go",
    stage: "late",
  },
  {
    id: "tiktok",
    body: "**TikTok.** If I had a foot, I would be tapping it right now. Did you know there is a whole thing called 'fidgeting physiology' *(type that 5 times fast)?*",
    cta: "Let's go",
    stage: "late",
  },
  {
    id: "worst-that-could-happen",
    body: "**What is the worst that could happen?** You become the life of the party by dropping knowledge bombs to the point that you gain enough confidence to dust off the windmill on the dance floor?",
    cta: "Let's go",
    stage: "late",
  },

  // Add the rest here, same shape as above — each needs a unique `id`
  // (used for the rotation, not shown anywhere), a `body`, and a `cta`,
  // plus an optional `stage` per the note above.
];

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
  if (!HOUSE_ADS.length) return null;
  const pool = stage ? HOUSE_ADS.filter((ad) => !ad.stage || ad.stage === stage) : HOUSE_ADS;
  const candidates = pool.length ? pool : HOUSE_ADS; // fail open if a stage has nothing tagged yet
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
