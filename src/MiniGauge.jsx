// Shared thin-bar gauge visual — one look used everywhere a "here's how
// much of something is used up" readout shows (the funded UsageGauge, and
// the header's free-search count). Deliberately just the bar + a label
// row underneath; callers own what the fraction/label text actually mean.
export default function MiniGauge({ label, valueText, fraction, color = "#E3A73C", trackColor = "#3A2E20" }) {
  const pct = Math.min(1, Math.max(0, fraction || 0));
  return (
    <div>
      <div className="rounded-full overflow-hidden" style={{ height: "2.5px", backgroundColor: trackColor }}>
        <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, backgroundColor: color }} />
      </div>
      <div className="flex justify-between rh-mono rh-text-10 mt-1" style={{ color: "#A89478" }}>
        <span>{label}</span>
        <span>{valueText}</span>
      </div>
    </div>
  );
}
