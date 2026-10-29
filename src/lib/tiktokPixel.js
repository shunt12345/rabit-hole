// TikTok Pixel — same posture as lib/redditPixel.js: only initializes on
// the live site (not local dev or Vercel previews), and never for a ?hyfax_test=1 browser, so
// local dev and the operator's own testing can't report conversions to the
// real ad account.
//
// Base snippet is TikTok's own (Ads Manager > Events Manager > Set up web
// events > Manually install pixel code), loaded from here rather than
// index.html, like the Reddit one. The pixel reads TikTok's ttclid click id
// off the landing URL by itself.
//
// Events reported (all TikTok standard events):
// - PageView on load (ttq.page)
// - ViewContent the first time a topic page loads in a session — the same
//   engagement signal the Reddit campaign reports as Lead
// - CompleteRegistration the first time a brand-new account signs in
// - Subscribe when the daily email form is submitted
// Each is mirrored server-side through report-tiktok-event (TikTok's Events
// API) with the same event_id; see track() below.
// Day-7 retention isn't something a web pixel reports; /admin's retention
// cohort table does that, filtered to the TikTok source (utm_source=tiktok).
import { isNewAccount } from "./auth.js";
import { isTestMode } from "./visitor.js";

// The pixel ID isn't a secret (it's in every page that loads the pixel).
// Hyfax's own is the default everywhere but local dev and Vercel preview
// deploys (same rule as index.html's base code); VITE_TIKTOK_PIXEL_ID
// overrides it.
const HYFAX_PIXEL_ID = "DBHLDJ3C77UASCMGRVU0";
const PIXEL_ID =
  import.meta.env.VITE_TIKTOK_PIXEL_ID ||
  (typeof window !== "undefined" && !/^(localhost|127\.0\.0\.1)$|\.vercel\.app$/.test(window.location.hostname) ? HYFAX_PIXEL_ID : undefined);

function reportingEnabled() {
  return !!PIXEL_ID && !isTestMode() && typeof window !== "undefined";
}

export function initTikTokPixel() {
  if (!reportingEnabled()) return;
  ttclid(); // keep the ad click id before the URL changes
  // Already loaded: by index.html's base code on the live site (where
  // TikTok's setup checker looks for it), or a StrictMode double-invoke.
  if (window.ttq) return;

  /* eslint-disable */
  !(function (w, d, t) {
    w.TiktokAnalyticsObject = t;
    var ttq = (w[t] = w[t] || []);
    (ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie", "holdConsent", "revokeConsent", "grantConsent"]),
      (ttq.setAndDefer = function (t, e) {
        t[e] = function () {
          t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
        };
      });
    for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
    (ttq.instance = function (t) {
      for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]);
      return e;
    }),
      (ttq.load = function (e, n) {
        var r = "https://analytics.tiktok.com/i18n/pixel/events.js";
        (ttq._i = ttq._i || {}), (ttq._i[e] = []), (ttq._i[e]._u = r), (ttq._t = ttq._t || {}), (ttq._t[e] = +new Date()), (ttq._o = ttq._o || {}), (ttq._o[e] = n || {});
        var o = d.createElement("script");
        (o.type = "text/javascript"), (o.async = !0), (o.src = r + "?sdkid=" + e + "&lib=" + t);
        var a = d.getElementsByTagName("script")[0];
        a.parentNode.insertBefore(o, a);
      });
    ttq.load(PIXEL_ID);
    ttq.page();
  })(window, document, "ttq");
  /* eslint-enable */
}

// TikTok's ad click id, kept for the visit it arrived on so a conversion
// later in the visit (a sign-up, the email form) still carries it.
const TTCLID_KEY = "hyfax-ttclid";
function ttclid() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("ttclid");
    if (fromUrl) sessionStorage.setItem(TTCLID_KEY, fromUrl);
    return fromUrl || sessionStorage.getItem(TTCLID_KEY) || "";
  } catch (_) {
    return "";
  }
}
// The pixel's own first-party browser id.
function ttpCookie() {
  const m = document.cookie.match(/(?:^|;\s*)_ttp=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Each event goes two ways with one event_id: the browser pixel, and the
// report-tiktok-event function (TikTok's Events API), which still lands
// when an ad blocker or Safari stops the pixel. TikTok dedupes the pair.
// Fire-and-forget: a failed report only means one event under-counts.
function track(event, props, email) {
  if (!reportingEnabled()) return;
  const eventId = crypto.randomUUID();
  if (window.ttq) {
    try {
      window.ttq.track(event, props || {}, { event_id: eventId });
    } catch (e) {
      console.error("Hyfax: TikTok pixel event failed", e);
    }
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  fetch(`${SUPABASE_URL}/functions/v1/report-tiktok-event`, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({
      event,
      eventId,
      url: window.location.href,
      referrer: document.referrer || undefined,
      ttclid: ttclid() || undefined,
      ttp: ttpCookie() || undefined,
      contentName: props?.content_name,
      email: email || undefined,
    }),
  }).catch((e) => console.error("Hyfax: failed to report TikTok event server-side", e));
}

// Once per browser, for a genuinely new account (see redditPixel.js's
// maybeReportSignUp for why created_at vs last_sign_in_at is the signal).
const SIGNUP_KEY = "hyfax-tiktok-signup-reported";
export function maybeReportTikTokSignUp(user) {
  if (!reportingEnabled() || !user || !isNewAccount(user)) return;
  try {
    if (localStorage.getItem(SIGNUP_KEY) === "1") return;
    localStorage.setItem(SIGNUP_KEY, "1");
  } catch (_) {
    // storage unavailable: a rare double-count beats never reporting
  }
  track("CompleteRegistration", {}, user.email);
}

// Once per session, the first topic page that loads.
const PAGE_KEY = "hyfax-tiktok-page-reported";
export function maybeReportTikTokPage(topic) {
  if (!reportingEnabled()) return;
  try {
    if (sessionStorage.getItem(PAGE_KEY) === "1") return;
    sessionStorage.setItem(PAGE_KEY, "1");
  } catch (_) {
    // storage unavailable: a rare double-count beats never reporting
  }
  track("ViewContent", { content_type: "product", content_name: String(topic || "").slice(0, 100) });
}

export function reportTikTokSubscribe(email) {
  track("Subscribe", {}, email);
}
