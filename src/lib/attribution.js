// Captures ad-attribution signals from the URL exactly once per browsing
// session and persists them in sessionStorage — not localStorage, since
// attribution should reset for a genuinely new visit (a new tab/window)
// rather than sticking around indefinitely the way the anonymous session
// id (lib/session.js) deliberately does. Read once on load (see App.jsx),
// then threaded onto every proxy request from then on (see api.js's
// streamRaw) so every logged row, not just the root call that happened to
// carry the URL params, can be attributed back to its source.
const KEY = "hyfax-attribution";

function readFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const utmSource = params.get("utm_source");
    const utmCampaign = params.get("utm_campaign");
    // Reddit's own click-id param, distinct from utm_source — present on a
    // real Reddit-served ad click regardless of whether the campaign also
    // sets utm_source=reddit, so worth capturing independently rather than
    // assuming the two always travel together.
    const rdtCid = params.get("rdt_cid");
    if (!utmSource && !utmCampaign && !rdtCid) return null;
    return { utmSource, utmCampaign, rdtCid };
  } catch (_) {
    return null;
  }
}

// Called once, on app load (see App.jsx) — a fresh URL hit with real
// attribution params overwrites whatever was stored before (so re-clicking
// a different ad link mid-session updates it), but a plain internal
// navigation with no params leaves the existing stored value alone rather
// than clearing it.
export function captureAttribution() {
  const fromUrl = readFromUrl();
  if (!fromUrl) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(fromUrl));
  } catch (_) {
    // storage unavailable — attribution just won't persist for this
    // session, not worth failing anything over
  }
}

// Read anywhere a request needs to attach attribution (see api.js). Never
// throws, never returns partial garbage — an empty object if nothing was
// ever captured or storage isn't available.
export function getAttribution() {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

export function isRedditVisit() {
  return getAttribution().utmSource === "reddit";
}
