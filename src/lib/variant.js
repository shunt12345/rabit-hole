// The "cards" vs "scroll" test: each browser is put in one group, at
// random, the first time it's asked, and stays there. "scroll" visitors
// get a page's Why cards opened for them as they scroll down to them (see
// App.jsx); "cards" visitors open them by tapping.
//
// Test traffic (?hyfax_test=1) is never assigned: it sees "cards" and
// reports no variant, so it can't land in either group's numbers. While
// the test is live, ?hyfax_variant=scroll or ?hyfax_variant=cards puts
// this browser in a group to try it (?hyfax_variant=0 clears it), never
// reported either.
import { isTestMode } from "./visitor.js";

const VARIANTS = ["cards", "scroll"];
// Switch for the whole test. Off for now: everyone sees "cards", nothing is
// assigned, and ?hyfax_variant= is ignored (a browser that was put in the
// scroll group that way is taken out of it).
const TEST_LIVE = false;
const KEY = "hyfax_variant";
const FORCE_KEY = "hyfax_variant_force";

export function applyVariantFromUrl() {
  try {
    if (!TEST_LIVE) {
      localStorage.removeItem(FORCE_KEY);
      return;
    }
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
  if (!TEST_LIVE) return "cards";
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
