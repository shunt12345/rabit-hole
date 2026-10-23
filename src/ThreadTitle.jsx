import { splitThreadTitle } from "./lib/chains.js";

// A Hyfax thread's title as its two ends, stacked: a small "From", the
// first topic large, a small "to", then the second topic large. Reads as
// a journey rather than one long headline.
export default function ThreadTitle({ title, size = "text-2xl", align = "left" }) {
  const { from, to } = splitThreadTitle(title);
  const small = "block rh-mono text-xs uppercase tracking-widest";
  const big = `block rh-display italic ${size} leading-tight`;
  return (
    <span className="block" style={{ textAlign: align }}>
      <span className={small} style={{ color: "#A89478" }}>
        From
      </span>
      <span className={big} style={{ color: "#F1E6D3" }}>
        {from}
      </span>
      {to && (
        <>
          <span className={`${small} mt-1.5`} style={{ color: "#A89478" }}>
            to
          </span>
          <span className={big} style={{ color: "#F1E6D3" }}>
            {to}
          </span>
        </>
      )}
    </span>
  );
}
