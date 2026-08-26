// A per-browser anonymous identifier, not tied to any account — just enough
// to group requests from the same visitor in the Phase 1 logging described
// in the handoff brief, so Phase 2's usage caps can be set from real data
// instead of a guess. Persisted in localStorage so it survives reloads
// within the same browser; a private window or cleared storage just gets a
// new one, which is fine for this purpose.
const KEY = "rabbit-hole-session-id";

export function getSessionId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch (_) {
    // storage unavailable (private mode edge cases, etc.) — fall back to an
    // in-memory id for this page load rather than breaking the app
    return "no-storage-" + Math.random().toString(36).slice(2);
  }
}
