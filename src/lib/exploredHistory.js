// Session/browser-local memory of topics dug into on this device — the
// free-tier half of the "continue exploring" hook (see conversation
// notes): no account needed, so it works for anonymous visitors too, but
// it's scoped to this one browser — gone in a different browser, a
// different device, or if site data gets cleared. The account-level,
// cross-device version of this is a separate, later piece of work.
//
// Stores a full root snapshot (overview + children), not just the topic
// label, so resuming is instant — no regeneration, no extra Claude call,
// nothing counted against the free-search limit.
const KEY = "hyfax-explored-topics";
const MAX_ENTRIES = 8;

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(entries) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Storage full, disabled, or unavailable (private browsing) — losing
    // history silently is fine, this is a nice-to-have, not core function.
  }
}

// Call once a root topic's overview + children are in hand, whether that
// came from a fresh generation or from resuming an earlier entry.
// Deduped by label — re-digging the same topic refreshes and re-fronts
// its entry instead of creating a second one. Most-recent-first, capped
// at MAX_ENTRIES so this can't grow without bound.
export function saveExploredRoot({ label, fullTopic, overview, children }) {
  if (!label) return;
  const entries = readAll().filter((e) => e.label !== label);
  entries.unshift({
    label,
    fullTopic: fullTopic || label,
    overview: overview || "",
    children: (children || []).map((c) => ({ label: c.label, teaser: c.teaser, type: c.type })),
    savedAt: Date.now(),
  });
  writeAll(entries.slice(0, MAX_ENTRIES));
}

export function getExploredHistory() {
  return readAll();
}
