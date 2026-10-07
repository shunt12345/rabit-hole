import React from "react";
import ReactDOM from "react-dom/client";
import Hyfax from "./App.jsx";
import AdminDashboard from "./AdminDashboard.jsx";
import ReviewQueue from "./ReviewQueue.jsx";
import { initRedditPixel } from "./lib/redditPixel.js";
import { captureAttribution } from "./lib/attribution.js";
import { applyTestModeFromUrl } from "./lib/visitor.js";
import "./index.css";

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
  initRedditPixel();
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>{isAdminRoute ? <AdminDashboard /> : isQueueRoute ? <ReviewQueue /> : <Hyfax />}</React.StrictMode>
);
