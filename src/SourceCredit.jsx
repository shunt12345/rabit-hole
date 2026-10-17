import { sourceDomain } from "./lib/heroPicks.js";

// A quiet credit for where a daily pick came from ("via npr.org"), opening
// the source in a new tab. Lives inside a card that is itself a button, so
// it's a span with link behaviour rather than a nested <a>, and stops the
// tap from also opening the card's thread.
export default function SourceCredit({ url, prefix = "via", className = "" }) {
  const domain = sourceDomain(url);
  if (!domain) return null;
  const open = (e) => {
    e.stopPropagation();
    e.preventDefault();
    window.open(url, "_blank", "noopener,noreferrer");
  };
  return (
    <span
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && open(e)}
      className={`rh-mono text-[11px] tracking-wide cursor-pointer hover:underline ${className}`}
      style={{ color: "#9A8868" }}
      title={`Source: ${domain}`}
    >
      {prefix} {domain} ↗
    </span>
  );
}
