import { ArrowUpRight } from "lucide-react";

// **bold** -> accent-gold, __underline__ -> underlined, *italic* ->
// italic, everything else plain. Kept intentionally tiny (no nesting) —
// this only needs to support what house ads actually use — see
// lib/houseAds.js for the format this is parsing. `**` has to be checked
// before the single-`*` alternative in the pattern below, or "**bold**"
// would match as italic-wrapping-italic instead of one bold span.
function parseAdBody(text) {
  const tokens = [];
  const pattern = /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(text))) {
    if (m.index > last) tokens.push({ type: "plain", text: text.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ type: "accent", text: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: "underline", text: m[2] });
    else tokens.push({ type: "italic", text: m[3] });
    last = pattern.lastIndex;
  }
  if (last < text.length) tokens.push({ type: "plain", text: text.slice(last) });
  return tokens;
}

// Unified card format for both the hero-page ad and the in-article ad —
// one visual shape everywhere a house ad shows. See App.jsx for where
// each slot is placed and how its ad is picked (lib/houseAds.js's
// pickHouseAd).
export default function AdCard({ ad, onClick }) {
  if (!ad) return null;
  const tokens = parseAdBody(ad.body);

  return (
    <div className="rounded-2xl p-4 flex gap-3 items-start text-left" style={{ backgroundColor: "#6E4A2C" }}>
      <div
        className="shrink-0 flex items-center justify-center rounded-xl"
        style={{ width: "44px", height: "44px", backgroundColor: "#14100C" }}
      >
        <img src="/hypha-logo.png" alt="" className="w-7 h-auto" />
      </div>
      <p className="rh-display text-sm leading-relaxed" style={{ color: "#FFFFFF" }}>
        {tokens.map((t, i) => {
          if (t.type === "accent") {
            return (
              <span key={i} style={{ color: "#E3A73C", fontWeight: 700 }}>
                {t.text}
              </span>
            );
          }
          if (t.type === "underline") {
            return (
              <span key={i} style={{ textDecoration: "underline" }}>
                {t.text}
              </span>
            );
          }
          if (t.type === "italic") {
            return (
              <span key={i} style={{ fontStyle: "italic" }}>
                {t.text}
              </span>
            );
          }
          return <span key={i}>{t.text}</span>;
        })}{" "}
        <button
          type="button"
          onClick={onClick}
          className="inline-flex items-center gap-0.5 font-semibold transition-colors"
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#E3A73C" }}
        >
          {ad.cta}
          <ArrowUpRight size={13} />
        </button>
      </p>
    </div>
  );
}
