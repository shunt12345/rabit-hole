// Visitor/session identity for the Adoption analytics tables (migration
// 0049) — deliberately separate from lib/session.js's "rabbit-hole-
// session-id" (which is really a persistent per-browser id used for the
// free-trial rate limits and stays untouched by this file) and from
// lib/attribution.js's sessionStorage snapshot (which is about tagging
// API requests, not this). Three independent concerns, three small files,
// rather than overloading one id for all of it.
//
// hyfax_vid: a UUID in localStorage, persists across visits/days — same
// in-memory fallback pattern as lib/session.js if storage is blocked
// (private mode, etc.), except the fallback here is cached at module
// scope so it stays stable across calls within the same page load even
// without storage, instead of generating a new one every call.
//
// Session: a run of activity with no gap longer than 30 minutes, tracked
// via a session id + a last-active timestamp, both in localStorage (NOT
// sessionStorage — a gap is purely about elapsed time, not whether the
// tab stayed open, so closing and reopening the browser 5 minutes later
// should still be the same session).
const VID_KEY = "hyfax_vid";
const SESSION_ID_KEY = "hyfax_sid";
const SESSION_LAST_ACTIVE_KEY = "hyfax_sid_last_active";
const TEST_KEY = "hyfax_test";
const SESSION_GAP_MS = 30 * 60 * 1000;

let inMemoryVisitorId = null;

function newId() {
  try {
    return crypto.randomUUID();
  } catch (_) {
    // crypto.randomUUID is broadly supported, but fall back rather than
    // throw on some exotic embedded webview that lacks it.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

export function getVisitorId() {
  try {
    let id = localStorage.getItem(VID_KEY);
    if (!id) {
      id = newId();
      localStorage.setItem(VID_KEY, id);
    }
    return id;
  } catch (_) {
    if (!inMemoryVisitorId) inMemoryVisitorId = newId();
    return inMemoryVisitorId;
  }
}

// Call on any real activity (app mount, a tap) — mints a new session id
// if there's no existing one or the gap since the last touch exceeded 30
// minutes, otherwise keeps the current one and just refreshes the
// timestamp. `isNewSession` tells the caller whether to fire a "land"
// event (see App.jsx) — only true the moment a session actually starts,
// never on every touch.
export function touchSession() {
  const now = Date.now();
  try {
    const lastActive = Number(localStorage.getItem(SESSION_LAST_ACTIVE_KEY) || 0);
    let sessionId = localStorage.getItem(SESSION_ID_KEY);
    const isNewSession = !sessionId || !lastActive || now - lastActive > SESSION_GAP_MS;
    if (isNewSession) {
      sessionId = newId();
      localStorage.setItem(SESSION_ID_KEY, sessionId);
    }
    localStorage.setItem(SESSION_LAST_ACTIVE_KEY, String(now));
    return { sessionId, isNewSession };
  } catch (_) {
    // No storage — every touch looks like a new session, which is the
    // closest honest approximation (nothing persists to compare against
    // anyway), rather than pretending continuity that storage can't back up.
    return { sessionId: newId(), isNewSession: true };
  }
}

// ?hyfax_test=1 opts this browser's visitor_id out of every /admin number
// (see admin-adoption-stats); ?hyfax_test=0 opts back in. Call once on app
// load, before anything reads isTestMode() or fires an event — same
// "capture once from the URL, persist until changed" shape as
// attribution.js's captureAttribution, just with an explicit off switch
// too (attribution has no equivalent "clear it" param).
export function applyTestModeFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("hyfax_test")) return;
    if (params.get("hyfax_test") === "0") {
      localStorage.removeItem(TEST_KEY);
    } else {
      localStorage.setItem(TEST_KEY, "1");
    }
  } catch (_) {
    // storage unavailable — test-mode just won't persist, not worth
    // failing anything over
  }
}

export function isTestMode() {
  try {
    return localStorage.getItem(TEST_KEY) === "1";
  } catch (_) {
    return false;
  }
}
