import React from "react";
import ReactDOM from "react-dom/client";
import Hyfax from "./App.jsx";
import AdminDashboard from "./AdminDashboard.jsx";
import ReviewQueue from "./ReviewQueue.jsx";
import { initRedditPixel } from "./lib/redditPixel.js";
import { captureAttribution } from "./lib/attribution.js";
import { applyTestModeFromUrl } from "./lib/visitor.js";
import { applyVariantFromUrl } from "./lib/variant.js";
import "./index.css";

// Topic and thread cards light up for as long as a finger is on them.
// Browsers' own :active press state is unreliable on phones, and pointer
// events get cancelled as soon as the browser thinks a touch might be a
// scroll or a long-press, which made the highlight just blink. Touch events
// keep reporting for the whole touch, so the card gets an "rh-pressed"
// class from touch-down to lift-off, and loses it early only if the finger
// actually moves (a scroll).
const PRESSABLE = ".rh-chip, .rh-thread-card";
const MOVE_TOLERANCE_PX = 10;
let pressed = null;
let startX = 0;
let startY = 0;
const release = (delay) => {
  const el = pressed;
  pressed = null;
  if (!el) return;
  if (delay) setTimeout(() => el.classList.remove("rh-pressed"), delay);
  else el.classList.remove("rh-pressed");
};
document.addEventListener(
  "touchstart",
  (e) => {
    release(0);
    const card = e.target.closest?.(PRESSABLE);
    if (!card || card.disabled || e.touches.length > 1) return;
    pressed = card;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    card.classList.add("rh-pressed");
  },
  { passive: true }
);
document.addEventListener(
  "touchmove",
  (e) => {
    if (!pressed) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > MOVE_TOLERANCE_PX || Math.abs(t.clientY - startY) > MOVE_TOLERANCE_PX) release(0);
  },
  { passive: true }
);
document.addEventListener("touchend", () => release(150), { passive: true });
document.addEventListener("touchcancel", () => release(0), { passive: true });

// /s/:id (a shared-article link, see lib/share.js) is served entirely by
// api/share.js on Vercel (see vercel.json's rewrite) as plain server
// rendered HTML — that's what makes link previews in iMessage/Twitter/
// Slack show the real article instead of a generic card. This app never
// renders that route client-side.
//
// /admin (usage stats, AdminDashboard.jsx) and /queue (content review,
// ReviewQueue.jsx) are the other real client-side routes — no router
// pulled in for just these two, since the main app itself has none
// either; vercel.json's catch-all rewrite already serves index.html for
// any path, so this is just a plain pathname check at mount time.
const path = window.location.pathname;
const isAdminRoute = path === "/admin";
const isQueueRoute = path === "/queue";
const isOperatorRoute = isAdminRoute || isQueueRoute;

// Before anything else reads it (App.jsx's Reddit entry-flow check, every
// proxy request's attribution fields) — see lib/attribution.js.
captureAttribution();

// Before the first "land" event (see App.jsx) can fire — ?hyfax_test=1/0
// needs to be applied before anything reads isTestMode(). Skipped on the
// operator routes (/admin, /queue) since those aren't part of the
// visitor-tracking flow at all — no events ever fire there.
if (!isOperatorRoute) {
  applyTestModeFromUrl();
  applyVariantFromUrl();
  initRedditPixel();
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>{isAdminRoute ? <AdminDashboard /> : isQueueRoute ? <ReviewQueue /> : <Hyfax />}</React.StrictMode>
);
