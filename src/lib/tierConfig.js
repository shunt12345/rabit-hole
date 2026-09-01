// Phase 1 of the tiered-usage design: PURE INSTRUMENTATION. This computes
// what tier a session would currently be in from real usage, so real
// sessions can be watched demoting through tiers before any feature is
// actually gated on it — the zone sizes below are starting guesses, not
// decisions, and are meant to be tuned once real data comes in. Nothing
// in the app reads TIER_CONFIG to change behavior yet; App.jsx only uses
// this to show a debug readout.
//
// The model (see conversation/design notes, not yet written up elsewhere):
// every session starts at the richest tier and gets demoted down through
// these zones as it racks up actions (root/expand/article/continuation
// calls through rabbit-hole-proxy) — never cut off entirely, resting on
// FLOOR_TIER once really exhausted. Free vs. paid (not built yet) would
// differ only in how big each zone is, not in this shape.
export const TIERS = [
  { key: "tier3", label: "Tier 3", nodesPerExpand: 5, features: { inTheNews: true, today: true, digDeeper: true }, zoneActions: 8 },
  { key: "tier2", label: "Tier 2", nodesPerExpand: 3, features: { inTheNews: false, today: true, digDeeper: false }, zoneActions: 8 },
  { key: "tier1", label: "Tier 1", nodesPerExpand: 3, features: { inTheNews: false, today: false, digDeeper: false }, zoneActions: 8 },
];

// The permanent floor everyone — free or paid — lands on once truly
// exhausted. Deliberately not "zero access": always some functionality,
// just the bare "type a topic, get an answer" shape. Exact feature set
// (0 branches vs. a small taste) is still an open question — placeholder
// for now, revisit once Phase 1 data shows how often sessions even reach
// it with these zone sizes.
export const FLOOR_TIER = {
  key: "floor",
  label: "Search",
  nodesPerExpand: 0,
  features: { inTheNews: false, today: false, digDeeper: false },
};

// actionsUsedToday is a rolling count of calls through rabbit-hole-proxy
// this session made today (see the proxy's X-Session-Actions-Today
// response header) — the same count already backing DAILY_REQUEST_LIMIT,
// just surfaced to the client instead of only used server-side.
export function tierForActionCount(actionsUsedToday) {
  const count = Math.max(0, actionsUsedToday || 0);
  let threshold = 0;
  for (const tier of TIERS) {
    const zoneEnd = threshold + tier.zoneActions;
    if (count < zoneEnd) {
      return { ...tier, actionsIntoZone: count - threshold, actionsToNextTier: zoneEnd - count };
    }
    threshold = zoneEnd;
  }
  return { ...FLOOR_TIER, actionsIntoZone: count - threshold, actionsToNextTier: null };
}
