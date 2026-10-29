// TikTok Pixel — same posture as lib/redditPixel.js: only initializes when
// VITE_TIKTOK_PIXEL_ID is set, and never for a ?hyfax_test=1 browser, so
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
// Day-7 retention isn't something a web pixel reports; /admin's retention
// cohort table does that, filtered to the TikTok source (utm_source=tiktok).
import { isNewAccount } from "./auth.js";
import { isTestMode } from "./visitor.js";

const PIXEL_ID = import.meta.env.VITE_TIKTOK_PIXEL_ID;

function reportingEnabled() {
  return !!PIXEL_ID && !isTestMode() && typeof window !== "undefined";
}

export function initTikTokPixel() {
  if (!reportingEnabled()) return;
  if (window.ttq) return; // already initialized (React.StrictMode double-invoke in dev)

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

function track(event, props) {
  if (!reportingEnabled() || !window.ttq) return;
  try {
    window.ttq.track(event, props || {});
  } catch (e) {
    console.error("Hyfax: TikTok pixel event failed", e);
  }
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
  track("CompleteRegistration");
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

export function reportTikTokSubscribe() {
  track("Subscribe");
}
