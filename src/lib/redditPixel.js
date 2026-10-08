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
import { isNewAccount } from "./auth.js";
import { isTestMode } from "./visitor.js";

const PIXEL_ID = import.meta.env.VITE_REDDIT_PIXEL_ID;

// A ?hyfax_test=1 browser (the operator's own testing) never reports to
// Reddit — neither the Pixel nor the server-side conversion — so test runs
// can't show up as real Leads or SignUps in the ad account.
function reportingEnabled() {
  return !!PIXEL_ID && !isTestMode();
}

export function initRedditPixel() {
  if (!reportingEnabled() || typeof window === "undefined") return;
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
  if (!reportingEnabled() || typeof window.rdt !== "function") return;
  window.rdt("track", "SignUp", { conversionId });
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Server-side mirror for both SignUp and Lead below — see the
// report-reddit-conversion edge function for why this matters beyond just
// the browser pixel (ad blockers, Safari ITP, etc. all silently drop the
// browser-side fire for a real chunk of visitors). Fire-and-forget: a
// failed report here just means this one conversion under-counts, never
// worth surfacing to the person whose action already succeeded.
function reportConversionServerSide(conversionId, eventType, email) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  fetch(`${SUPABASE_URL}/functions/v1/report-reddit-conversion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ conversionId, eventType, ...(email ? { email } : {}) }),
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
  if (!reportingEnabled() || !user) return;
  try {
    if (localStorage.getItem(SIGNUP_REPORTED_KEY) === "1") return;
  } catch (_) {
    // storage unavailable — proceed rather than silently never reporting
  }

  if (!isNewAccount(user)) return;

  try {
    localStorage.setItem(SIGNUP_REPORTED_KEY, "1");
  } catch (_) {
    // worst case (storage unavailable) this fires again next load — a rare
    // double-count is a far smaller problem than never reporting at all
  }

  const conversionId = crypto.randomUUID();
  trackSignUp(conversionId);
  reportConversionServerSide(conversionId, "SignUp", user.email);
}

const LEAD_REPORTED_KEY = "hyfax-reddit-lead-reported";

// Fires once per SESSION (sessionStorage, not localStorage — unlike
// SignUp's once-ever-per-browser scope, "a session that ran a search" is
// meant to reset each real visit) the first time a root topic actually
// succeeds. This is the Reddit ad campaign's real engagement signal per
// the brief: most clickers never run a search at all, so a completed root
// request is worth reporting as a Lead distinctly from the page load
// itself (already covered by PageVisit in initRedditPixel above).
//
// Mirrored server-side via report-reddit-conversion (same conversionId,
// same dedup story as SignUp) — most root requests are from anonymous
// visitors with no email to attach, so `email` here is optional and just
// omitted from the CAPI payload when there isn't one (see App.jsx's
// startTopic, which passes the signed-in user's email when it has one).
export function maybeReportLead(email) {
  if (!reportingEnabled()) return;
  try {
    if (sessionStorage.getItem(LEAD_REPORTED_KEY) === "1") return;
    sessionStorage.setItem(LEAD_REPORTED_KEY, "1");
  } catch (_) {
    // storage unavailable — proceed rather than silently never reporting;
    // worst case (a private-mode edge case) is a rare double-count
  }
  const conversionId = crypto.randomUUID();
  if (typeof window.rdt === "function") {
    window.rdt("track", "Lead", { conversionId });
  }
  reportConversionServerSide(conversionId, "Lead", email);
}
