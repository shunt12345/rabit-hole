// Reads/writes the signed-in user's own profile row directly via the
// Supabase client (not a proxy endpoint) — RLS's "Users can read own
// profile" policy (migration 0009) already scopes selects to exactly one
// row, and migration 0011's column-level grant is what makes the feature
// toggles (and only those columns) writable this way; balance_usd itself
// is NOT in that grant, so this can never be used to set your own balance
// even though it's readable here.
import { supabase } from "./supabaseClient.js";

// Section C of the production punch list (funded experience): balance plus
// the per-feature toggle preferences (News/Today/Dig Deeper/Email — Email
// is a placeholder toggle for the not-yet-built digest, punch list Section
// E; Explore's node-count toggle is explicitly deferred, see the punch
// list's Section G, so it isn't read/written here).
export async function getProfile() {
  const { data, error } = await supabase
    .from("profiles")
    .select("balance_usd, feature_news, feature_today, feature_dig_deeper, feature_email")
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
        featureEmail: data.feature_email,
      }
    : null;
}

// `toggles` is a partial { featureNews?, featureToday?, featureDigDeeper?,
// featureEmail? }. RLS's "Users can update own profile" policy already
// restricts this to exactly the caller's own row regardless of what filter
// is sent — but Supabase's PostgREST layer separately refuses to run an
// UPDATE with NO filter at all in the request itself (a distinct safety
// check from RLS, there to catch accidental "update every row" calls),
// returning a 21000 "UPDATE requires a WHERE clause" error. So the
// explicit .eq("id", ...) below isn't for security — RLS was already
// enough for that — it's required just to get PostgREST to accept the
// request at all. getSession() reads from local storage, no network round
// trip.
export async function updateFeatureToggles(toggles) {
  const patch = {};
  if ("featureNews" in toggles) patch.feature_news = !!toggles.featureNews;
  if ("featureToday" in toggles) patch.feature_today = !!toggles.featureToday;
  if ("featureDigDeeper" in toggles) patch.feature_dig_deeper = !!toggles.featureDigDeeper;
  if ("featureEmail" in toggles) patch.feature_email = !!toggles.featureEmail;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not signed in.");

  const { error } = await supabase.from("profiles").update(patch).eq("id", userId);
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
