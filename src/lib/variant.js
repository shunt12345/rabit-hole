// The "cards" vs "scroll" test: each browser is put in one group, at
// random, the first time it's asked, and stays there. "scroll" visitors
// get the next thread's page added below the current one as they scroll
// (see App.jsx); "cards" visitors see the page as before.
//
// Test traffic (?hyfax_test=1) is never assigned: it sees "cards" and
// reports no variant, so it can't land in either group's numbers. To try
// a group yourself, open any page with ?hyfax_variant=scroll or
// ?hyfax_variant=cards (?hyfax_variant=0 clears it); that choice stays in
// this browser and is never reported either.
import { isTestMode } from "./visitor.js";

const VARIANTS = ["cards", "scroll"];
// Off until migration 0063 and the track-event update are live (the old
// track-event refuses scroll_continue events); everyone sees "cards" and
// nothing is assigned. A forced group (?hyfax_variant=) still works.
const TEST_LIVE = false;
const KEY = "hyfax_variant";
const FORCE_KEY = "hyfax_variant_force";

export function applyVariantFromUrl() {
  try {
    const wanted = new URLSearchParams(window.location.search).get("hyfax_variant");
    if (wanted === null) return;
    if (VARIANTS.includes(wanted)) localStorage.setItem(FORCE_KEY, wanted);
    else localStorage.removeItem(FORCE_KEY);
  } catch (_) {
    // no storage: nothing to remember
  }
}

let inMemory = null;

// The group this browser sees.
export function getVariant() {
  try {
    const forced = localStorage.getItem(FORCE_KEY);
    if (VARIANTS.includes(forced)) return forced;
  } catch (_) {
    // fall through
  }
  if (!TEST_LIVE || isTestMode()) return "cards";
  try {
    let v = localStorage.getItem(KEY);
    if (!VARIANTS.includes(v)) {
      v = VARIANTS[Math.random() < 0.5 ? 0 : 1];
      localStorage.setItem(KEY, v);
    }
    return v;
  } catch (_) {
    if (!inMemory) inMemory = VARIANTS[Math.random() < 0.5 ? 0 : 1];
    return inMemory;
  }
}

// The group to record on this visitor in /admin: none for test traffic or
// a browser that picked its own group.
export function reportedVariant() {
  try {
    if (localStorage.getItem(FORCE_KEY)) return null;
  } catch (_) {
    // fall through
  }
  return !TEST_LIVE || isTestMode() ? null : getVariant();
}
