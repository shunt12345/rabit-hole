import React from "react";
import ReactDOM from "react-dom/client";
import Hyfax from "./App.jsx";
import AdminDashboard from "./AdminDashboard.jsx";
import { initRedditPixel } from "./lib/redditPixel.js";
import "./index.css";

// /s/:id (a shared-article link, see lib/share.js) is served entirely by
// api/share.js on Vercel (see vercel.json's rewrite) as plain server
// rendered HTML — that's what makes link previews in iMessage/Twitter/
// Slack show the real article instead of a generic card. This app never
// renders that route client-side.
//
// /admin is the one other real client-side route (see AdminDashboard.jsx)
// — no router pulled in for just this, since the main app itself has none
// either; vercel.json's catch-all rewrite already serves index.html for
// any path, so this is just a plain pathname check at mount time.
const isAdminRoute = window.location.pathname === "/admin";

if (!isAdminRoute) initRedditPixel();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>{isAdminRoute ? <AdminDashboard /> : <Hyfax />}</React.StrictMode>
);
