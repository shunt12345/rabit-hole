// Whether the first-time "Welcome" modal has already been shown on this
// browser — a single boolean flag, intentionally its own tiny module
// rather than folded into exploredHistory.js's history tracking.
const KEY = "hyfax-welcome-seen";

export function hasSeenWelcome() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Storage unavailable (private browsing, disabled, etc.) — fail toward
    // NOT showing an unexpected popup rather than showing it every load.
    return true;
  }
}

export function markWelcomeSeen() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Nothing to do — worst case it just shows again next visit.
  }
}
