import { useEffect, useState } from "react";
import { Loader2, AlertCircle, Sparkles } from "lucide-react";
import { getSharedArticle } from "./lib/share.js";

const TYPE_COLOR = {
  root: "#C1552E",
  direct: "#E3A73C",
  indirect: "#7E9471",
  tangent: "#9C6B8C",
  custom: "#6C93A8",
};

const TYPE_LABEL = {
  direct: "Direct",
  indirect: "Indirect",
  tangent: "Tangent",
  custom: "Yours",
};

// Word-of-mouth landing page — rendered instead of the main app when the
// URL is /s/:id (see main.jsx). No sign-in, no app state: just the
// snapshotted article plus a way in for whoever it was sent to. Kept as
// its own small component rather than reusing App.jsx's article view,
// since that view is wired to live node/session state this page
// deliberately doesn't have.
export default function SharedArticle({ id }) {
  const [state, setState] = useState({ status: "loading" }); // loading | ready | notfound | error

  useEffect(() => {
    let cancelled = false;
    getSharedArticle(id)
      .then((row) => {
        if (cancelled) return;
        if (!row) setState({ status: "notfound" });
        else setState({ status: "ready", row });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="w-full min-h-screen flex flex-col rh-body" style={{ backgroundColor: "#14100C" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;1,500&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
        .rh-display { font-family: 'Fraunces', serif; }
        .rh-body { font-family: 'Inter', sans-serif; }
        .rh-mono { font-family: 'JetBrains Mono', monospace; }
        .rh-btn-accent:hover { background-color: #EDB94F !important; }
        .rh-text-10 { font-size: 10px; }
        .rh-tracking-25 { letter-spacing: 0.25em; }
      `}</style>

      <div className="flex flex-col items-center p-5 md:p-7 shrink-0">
        <a href="/" className="flex items-center" style={{ opacity: 1 }}>
          <img src="/hypha-logo.png" alt="Hypha" className="h-8 md:h-10 w-auto" />
        </a>
        <div className="rh-mono rh-text-10 rh-tracking-25 uppercase mt-1" style={{ color: "#A89478" }}>
          always another thread
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center px-6 pb-16">
        <div className="max-w-2xl w-full">
          {state.status === "loading" && (
            <div className="flex items-center gap-1.5 justify-center mt-16 text-base" style={{ color: "#B8A886" }}>
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          )}

          {(state.status === "notfound" || state.status === "error") && (
            <div className="mt-16 text-center">
              <div className="flex items-center gap-1.5 justify-center text-base mb-2" style={{ color: "#D98A6E" }}>
                <AlertCircle size={15} />
                {state.status === "notfound" ? "This link doesn't lead anywhere." : "Couldn't load this article."}
              </div>
              <p className="text-sm" style={{ color: "#A89478" }}>
                It may have been mistyped, or no longer exists.
              </p>
            </div>
          )}

          {state.status === "ready" && (
            <div className="rh-fade-in">
              <span
                className="rh-mono rh-text-10 uppercase tracking-wider px-2 py-0.5 rounded-full inline-block mb-3"
                style={{
                  color: TYPE_COLOR[state.row.node_type] || "#E3A73C",
                  border: `1px solid ${TYPE_COLOR[state.row.node_type] || "#E3A73C"}55`,
                }}
              >
                {state.row.node_type === "root" ? "Origin" : TYPE_LABEL[state.row.node_type] || "Thread"}
              </span>

              <h2 className="rh-display text-3xl italic mb-4" style={{ color: "#F1E6D3" }}>
                {state.row.topic_label}
              </h2>

              <div className="text-base leading-relaxed" style={{ color: "#F5EDDC" }}>
                {state.row.overview && <p className="mb-4">{state.row.overview}</p>}
                {state.row.article
                  .split(/\n\s*\n/)
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((para, i) => (
                    <p key={i} className="mt-4">
                      {para}
                    </p>
                  ))}
              </div>

              <div className="mt-12 pt-8 border-t text-center" style={{ borderColor: "#3A2E20" }}>
                <p className="rh-body text-sm mb-4" style={{ color: "#A89478" }}>
                  Someone shared this with you. Follow your own thought as far as it goes.
                </p>
                <a
                  href="/"
                  className="rh-body inline-flex items-center gap-1.5 text-sm font-medium rounded-full px-5 py-3 transition-colors rh-btn-accent"
                  style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
                >
                  <Sparkles size={15} /> Dig in yourself
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
