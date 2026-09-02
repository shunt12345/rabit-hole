// Reads the signed-in user's own profile row directly via the Supabase
// client (not a proxy endpoint) — RLS's "Users can read own profile"
// policy (migration 0009) already scopes this to exactly one row, so no
// separate edge function is needed just to display a balance.
import { supabase } from "./supabaseClient.js";

export async function getBalance() {
  const { data, error } = await supabase.from("profiles").select("balance_usd").maybeSingle();
  if (error) {
    console.error("Hypha: failed to read balance", error);
    return null;
  }
  return data ? Number(data.balance_usd) : null;
}
