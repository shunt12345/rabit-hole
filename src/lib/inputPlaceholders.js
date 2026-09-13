// Rotating placeholder examples for the Dig In input — a fixed, hand-
// written list, not generated per visit (no reason to spend an API call on
// example text nobody actually reads as content). Same localStorage-backed
// round robin as lib/openerVariety.js, for the same reason: a fresh
// Math.random() pick can repeat back-to-back, and a round robin guarantees
// each visit actually sees something different from the last.
const PLACEHOLDER_EXAMPLES = [
  "octopus cognition, silk road, fermentation…",
  "black holes, sourdough starters, ancient Rome…",
  "bioluminescence, jazz improvisation, tectonic plates…",
  "the printing press, coral reefs, cryptography…",
  "lucid dreaming, medieval castles, mushroom networks…",
  "migratory birds, the Roman aqueducts, quantum entanglement…",
  "honeybee dances, volcanic eruptions, deep sea creatures…",
  "the stock market, Norse mythology, bioluminescent fungi…",
];

const STORAGE_KEY = "hyfax-placeholder-idx";

// Fails toward "always the first example" if storage is unavailable — a
// lost rotation is cosmetic, not worth any special handling.
export function nextInputPlaceholder() {
  let idx = 0;
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    idx = Number.isFinite(stored) && stored >= 0 ? (stored + 1) % PLACEHOLDER_EXAMPLES.length : 0;
    localStorage.setItem(STORAGE_KEY, String(idx));
  } catch (_) {
    // ignore — see comment above
  }
  return PLACEHOLDER_EXAMPLES[idx];
}
