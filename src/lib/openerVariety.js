// Forces real variety in the article's second-paragraph opener across
// separate articles read by one active user — a stateless model told to
// "vary this each time" has no memory of what it picked on the LAST call,
// so independent generations converge on the same shape far more often
// than the system prompt's own "pick a different one" instruction alone
// would suggest. Confirmed live: the same opener style kept recurring
// across different articles for one user reading several in a row.
//
// A localStorage-backed round robin (not random, which can repeat back to
// back) guarantees each successive article gets a genuinely different
// assignment instead of hoping the model self-varies from a stateless
// start every time. Scoped to just the second-paragraph opener — the one
// spot this was actually reported, not the first-paragraph hook too.
const OPENER_SHAPES = [
  "drop a startling concrete number or fact cold, with no windup",
  "name a specific person, place, date, or object first, before anything else",
  "ask a real question — not rhetorical filler, an actual question the rest of the paragraph answers",
  "paint a quick physical image or scene in one sentence",
  "state something flatly and matter-of-fact, with no transition or lead-in at all",
];

const STORAGE_KEY = "hyfax-opener-shape-idx";

// Fails toward "always the first shape" if storage is unavailable — a lost
// rotation is a cosmetic regression, not worth failing the whole article
// generation over.
export function nextOpenerShape() {
  let idx = 0;
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    idx = Number.isFinite(stored) && stored >= 0 ? (stored + 1) % OPENER_SHAPES.length : 0;
    localStorage.setItem(STORAGE_KEY, String(idx));
  } catch (_) {
    // ignore — see comment above
  }
  return OPENER_SHAPES[idx];
}
