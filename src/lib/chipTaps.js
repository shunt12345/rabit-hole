// Per-session counter of "Explore next" chip taps (branching from one
// topic into another already-generated child) — backs the soft sign-up
// nudge that appears after the 3rd one. sessionStorage, not localStorage:
// this is meant to catch someone mid-exploration in THIS visit, not follow
// them around forever once dismissed.
const COUNT_KEY = "hyfax-chip-tap-count";
const DISMISSED_KEY = "hyfax-signup-prompt-dismissed";

export function recordChipTap() {
  try {
    const n = Number(sessionStorage.getItem(COUNT_KEY) || "0") + 1;
    sessionStorage.setItem(COUNT_KEY, String(n));
    return n;
  } catch (_) {
    return 0;
  }
}

export function hasDismissedSignUpPrompt() {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch (_) {
    return false;
  }
}

export function dismissSignUpPrompt() {
  try {
    sessionStorage.setItem(DISMISSED_KEY, "1");
  } catch (_) {
    // worst case it shows again — not worth failing anything over
  }
}
