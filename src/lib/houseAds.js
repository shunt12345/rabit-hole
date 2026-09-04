// House ads promoting Hypha's own subscription/funding (production punch
// list, Section H) — replaces the third-party MOCK_SPONSOR placeholders
// in the hero and in-article ad slots. The "Explore next" chip ad is a
// separate, constant slot and stays out of this rotation (see App.jsx).
//
// Written by hand, not generated — this is the one file to edit to
// add/change an ad. Body is plain text with two lightweight inline
// markers, similar to markdown, so an ad's whole look lives in one
// string without touching any component code:
//   **text**  -> accent-gold color (the opening hook)
//   __text__  -> underlined
// Anything else renders as normal body text. CTA is a separate field —
// it always renders as the gold link at the end of the card. See
// AdCard.jsx for the parser/renderer.
export const HOUSE_ADS = [
  {
    id: "death-scrolling",
    body: "**Death scrolling again?!** Come on. I get it you got some __you time__ finally but replacing the social with Hyfa with that fresh feeling of knowledge rather than … well you know.",
    cta: "Let's go",
  },

  // Add the rest here, same shape as above — each needs a unique `id`
  // (used for the rotation, not shown anywhere), a `body`, and a `cta`.
];

// Deterministic pick — the same seed always returns the same ad (so a
// given node/session doesn't flicker between different ads on
// re-render), but different seeds spread across the list. Not true
// randomness and no impression tracking yet — simplest thing that
// actually rotates as people move between sessions and topics, worth
// revisiting once there's real click data to weight by (same pattern as
// the cost/latency work elsewhere in this app).
export function pickHouseAd(seed) {
  if (!HOUSE_ADS.length) return null;
  let h = 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return HOUSE_ADS[h % HOUSE_ADS.length];
}
