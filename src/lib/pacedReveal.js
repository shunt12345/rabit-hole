// Sits between a raw network stream (which arrives in bursty, unevenly
// sized chunks — a fast run of tokens, then a pause, then another burst)
// and the UI. Feed it the latest known full text via `push`; instead of
// jumping straight to whatever just arrived over the wire, it reveals
// characters at a steady rate so the text appears to type itself at a
// natural, even pace regardless of how lumpy the underlying deltas are.

// ~250 words/minute at ~5.3 characters/word (the commonly cited average
// adult silent-reading speed) — a natural typing pace, not a race to
// display whatever's buffered.
const READING_CHARS_PER_SEC = 22;

export function createPacedReveal(onReveal, charsPerSecond = READING_CHARS_PER_SEC) {
  let target = "";
  let revealed = "";
  let done = false;
  let raf = null;
  let lastTs = null;
  let carry = 0;
  let resolveFinish = null;

  function stopLoop() {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
    lastTs = null;
  }

  function tick(ts) {
    if (lastTs == null) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    carry += dt * charsPerSecond;
    const grow = Math.floor(carry);
    if (grow > 0 && revealed.length < target.length) {
      carry -= grow;
      revealed = target.slice(0, Math.min(target.length, revealed.length + grow));
      onReveal(revealed);
    }
    if (revealed.length >= target.length) {
      stopLoop();
      if (done && resolveFinish) {
        resolveFinish();
        resolveFinish = null;
      }
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function ensureRunning() {
    if (raf == null) raf = requestAnimationFrame(tick);
  }

  return {
    // Call as new text becomes available from the network. `fullText` is
    // the whole accumulated text so far, not just the new delta.
    push(fullText) {
      target = fullText;
      ensureRunning();
    },
    // Call once the network stream has ended. Resolves once the paced
    // reveal has actually caught up to `finalText` on screen — callers
    // that want the UI to stay in a "streaming" state until every
    // character has visibly appeared should await this.
    finish(finalText) {
      target = finalText;
      done = true;
      ensureRunning();
      return new Promise((resolve) => {
        if (revealed.length >= target.length) resolve();
        else resolveFinish = resolve;
      });
    },
    // Reveal everything immediately and stop — for error paths where
    // there's no point pacing out text that's about to be replaced anyway.
    cancel() {
      stopLoop();
    },
  };
}
