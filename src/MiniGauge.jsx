// Shared thin-bar gauge visual — one look used everywhere a "here's how
// much of something is used up" readout shows (the funded UsageGauge, and
// the header's free-search count). Deliberately just the bar + a label
// row underneath; callers own what the fraction/label text actually mean.
//
// `centered`: drops valueText and centers the label alone underneath the
// bar instead of the default label-left/value-right row. UsageGauge uses
// this — a bare "11%" reading next to a bar read like a taxi meter, and
// the bar itself already shows the fraction visually. The free-search
// gauge keeps the default row (its "3/6" value is worth spelling out,
// unlike a percentage the bar already communicates).
export default function MiniGauge({ label, valueText, fraction, color = "#E3A73C", trackColor = "#3A2E20", centered = false }) {
  const pct = Math.min(1, Math.max(0, fraction || 0));
  return (
    <div>
      <div className="rounded-full overflow-hidden" style={{ height: "2.5px", backgroundColor: trackColor }}>
        <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, backgroundColor: color }} />
      </div>
      {centered ? (
        <div className="text-center rh-mono rh-text-10 mt-1" style={{ color: "#A89478" }}>
          {label}
        </div>
      ) : (
        <div className="flex justify-between rh-mono rh-text-10 mt-1" style={{ color: "#A89478" }}>
          <span>{label}</span>
          <span>{valueText}</span>
        </div>
      )}
    </div>
  );
}
