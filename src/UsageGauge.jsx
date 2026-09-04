// Real usage gauge (production punch list, Section C): fraction of every
// dollar ever funded that's already been spent — a real, non-fabricated
// number rather than an arbitrary made-up ceiling. Lives on the hero page
// now (moved out of the account modal) so it's visible right where
// someone's about to spend more, not tucked away behind a tap.
//
// Renders nothing until there's something real to show: signed out,
// never funded, or profile/lifetimeFunded still loading all fall through
// to null rather than a placeholder/skeleton state.
export default function UsageGauge({ profile, lifetimeFunded }) {
  if (!profile || !lifetimeFunded || lifetimeFunded <= 0) return null;
  const usageFraction = Math.min(1, Math.max(0, 1 - profile.balanceUsd / lifetimeFunded));

  return (
    <div className="max-w-md mx-auto mt-3">
      <div className="rounded-full overflow-hidden" style={{ height: "2.5px", backgroundColor: "#3A2E20" }}>
        <div className="h-full rounded-full" style={{ width: `${usageFraction * 100}%`, backgroundColor: "#E3A73C" }} />
      </div>
      <div className="flex justify-between rh-mono rh-text-10 mt-1" style={{ color: "#A89478" }}>
        <span>Usage</span>
        <span>{Math.round(usageFraction * 100)}%</span>
      </div>
    </div>
  );
}
