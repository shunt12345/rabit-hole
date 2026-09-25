// Reddit Ads Pixel — only initializes when VITE_REDDIT_PIXEL_ID is set, so
// local dev and any deploy without a real Pixel ID configured silently
// no-ops instead of reporting bogus/test conversions to a real ad account.
//
// Base snippet is Reddit's own (from Ads Manager > Events Manager > Install
// the Pixel), inlined here rather than a separate <script src> tag in
// index.html — this keeps it consistent with how every other client-safe
// credential in this app (Supabase URL/anon key, Stripe publishable key)
// is threaded through import.meta.env instead of hardcoded into the HTML.
//
// SignUp is the one funnel event this app currently reports (see App.jsx's
// onAuthStateChange handling) — mirrored server-side via the
// report-reddit-conversion edge function (Reddit's Conversions API) using
// the SAME conversionId, so Reddit can dedupe the browser pixel fire
// against the server-side one instead of double-counting one real sign-up.
const PIXEL_ID = import.meta.env.VITE_REDDIT_PIXEL_ID;

export function initRedditPixel() {
  if (!PIXEL_ID || typeof window === "undefined") return;
  if (window.rdt) return; // already initialized (React.StrictMode double-invoke in dev)

  /* eslint-disable */
  !(function (w, d) {
    if (!w.rdt) {
      var p = (w.rdt = function () {
        p.sendEvent ? p.sendEvent.apply(p, arguments) : p.callQueue.push(arguments);
      });
      p.callQueue = [];
      var t = d.createElement("script");
      (t.src = "https://www.redditstatic.com/ads/pixel.js"), (t.async = true);
      var s = d.getElementsByTagName("script")[0];
      s.parentNode.insertBefore(t, s);
    }
  })(window, document);
  /* eslint-enable */

  window.rdt("init", PIXEL_ID);
  window.rdt("track", "PageVisit");
}

// Fires once, the first time a brand-new account is detected (see App.jsx's
// onAuthStateChange handling — never for a returning sign-in). `conversionId`
// is a fresh UUID shared with the matching report-reddit-conversion CAPI
// call so Reddit can dedupe the two instead of counting one real sign-up
// twice.
function trackSignUp(conversionId) {
  if (!PIXEL_ID || typeof window.rdt !== "function") return;
  window.rdt("track", "SignUp", { conversionId });
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Server-side mirror of trackSignUp above — see the report-reddit-conversion
// edge function for why this matters beyond just the browser pixel (ad
// blockers, Safari ITP, etc. all silently drop the browser-side fire for a
// real chunk of visitors). Fire-and-forget: a failed report here just means
// this one conversion under-counts, never worth surfacing to the person who
// already successfully signed up.
function reportSignUpServerSide(conversionId, email) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  fetch(`${SUPABASE_URL}/functions/v1/report-reddit-conversion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ conversionId, eventType: "SignUp", email }),
  }).catch((e) => console.error("Hyfax: failed to report Reddit conversion server-side", e));
}

const SIGNUP_REPORTED_KEY = "hyfax-reddit-signup-reported";

// Called on every auth-state change (see App.jsx) with whatever user is
// currently signed in (or null). Reports a "SignUp" conversion at most once
// per browser, and only for a genuinely NEW account — Supabase's magic-link
// flow fires the identical SIGNED_IN event for both a brand-new account and
// an ordinary returning sign-in, so the event type alone can't tell them
// apart. created_at and last_sign_in_at landing within a minute of each
// other is the real signal: that's only true the very first time someone
// ever signs in.
export function maybeReportSignUp(user) {
  if (!PIXEL_ID || !user) return;
  try {
    if (localStorage.getItem(SIGNUP_REPORTED_KEY) === "1") return;
  } catch (_) {
    // storage unavailable — proceed rather than silently never reporting
  }

  const createdAt = new Date(user.created_at).getTime();
  const lastSignInAt = new Date(user.last_sign_in_at || user.created_at).getTime();
  const isNewAccount = Number.isFinite(createdAt) && Math.abs(lastSignInAt - createdAt) <= 60_000;
  if (!isNewAccount) return;

  try {
    localStorage.setItem(SIGNUP_REPORTED_KEY, "1");
  } catch (_) {
    // worst case (storage unavailable) this fires again next load — a rare
    // double-count is a far smaller problem than never reporting at all
  }

  const conversionId = crypto.randomUUID();
  trackSignUp(conversionId);
  reportSignUpServerSide(conversionId, user.email);
}
