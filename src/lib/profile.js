// Reads/writes the signed-in user's own profile row directly via the
// Supabase client (not a proxy endpoint) — RLS's "Users can read own
// profile" policy (migration 0009) already scopes selects to exactly one
// row, and migration 0011's column-level grant is what makes the feature
// toggles (and only those columns) writable this way; balance_usd itself
// is NOT in that grant, so this can never be used to set your own balance
// even though it's readable here.
import { supabase } from "./supabaseClient.js";

// Section C of the production punch list (funded experience): balance plus
// the per-feature toggle preferences (News/Today/Dig Deeper — Explore's
// node-count toggle is explicitly deferred, see the punch list's Section
// G, so it isn't read/written here).
export async function getProfile() {
  const { data, error } = await supabase
    .from("profiles")
    .select("balance_usd, feature_news, feature_today, feature_dig_deeper")
    .maybeSingle();
  if (error) {
    console.error("Hypha: failed to read profile", error);
    return null;
  }
  return data
    ? {
        balanceUsd: Number(data.balance_usd),
        featureNews: data.feature_news,
        featureToday: data.feature_today,
        featureDigDeeper: data.feature_dig_deeper,
      }
    : null;
}

// `toggles` is a partial { featureNews?, featureToday?, featureDigDeeper? }
// — no explicit .eq("id", ...) filter needed since RLS's "Users can update
// own profile" policy already scopes any update through this client to
// exactly the caller's own row; adding one would just mean a second round
// trip to look up the id first.
export async function updateFeatureToggles(toggles) {
  const patch = {};
  if ("featureNews" in toggles) patch.feature_news = !!toggles.featureNews;
  if ("featureToday" in toggles) patch.feature_today = !!toggles.featureToday;
  if ("featureDigDeeper" in toggles) patch.feature_dig_deeper = !!toggles.featureDigDeeper;
  const { error } = await supabase.from("profiles").update(patch);
  if (error) {
    console.error("Hypha: failed to update feature toggles", error);
    throw error;
  }
}

// Sum of every successful top-up ever made — the denominator for the
// "Usage" gas-gauge (balance remaining / lifetime funded), so the gauge
// reflects a real number instead of an arbitrary made-up ceiling.
export async function getLifetimeFundedUsd() {
  const { data, error } = await supabase.from("billing_transactions").select("amount_usd");
  if (error) {
    console.error("Hypha: failed to read billing transactions", error);
    return null;
  }
  return data.reduce((sum, row) => sum + Number(row.amount_usd), 0);
}
