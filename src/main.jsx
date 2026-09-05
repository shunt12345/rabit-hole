import React from "react";
import ReactDOM from "react-dom/client";
import Hyfax from "./App.jsx";
import "./index.css";

// /s/:id (a shared-article link, see lib/share.js) is served entirely by
// api/share.js on Vercel (see vercel.json's rewrite) as plain server
// rendered HTML — that's what makes link previews in iMessage/Twitter/
// Slack show the real article instead of a generic card. This app never
// renders that route client-side.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Hyfax />
  </React.StrictMode>
);
