import React from "react";
import ReactDOM from "react-dom/client";
import Hypha from "./App.jsx";
import SharedArticle from "./SharedArticle.jsx";
import "./index.css";

// No router dependency for one route — a shared-article link
// (/s/:id, see share.js) is the only URL this app ever needs to
// distinguish from the root app itself.
const sharedMatch = window.location.pathname.match(/^\/s\/([A-Za-z0-9]+)$/);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {sharedMatch ? <SharedArticle id={sharedMatch[1]} /> : <Hypha />}
  </React.StrictMode>
);
