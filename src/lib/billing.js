// Section D of the production punch list (billing). Starts a Stripe
// Checkout session for a one-time balance top-up and redirects the
// browser there — this app never touches card details itself (Stripe
// Checkout is hosted), so there's no PCI-scoped form to build or secure
// here. See supabase/functions/create-checkout-session for the server side.
import { getAccessToken } from "./auth.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const CHECKOUT_URL = `${SUPABASE_URL}/functions/v1/create-checkout-session`;

// Matches create-checkout-session's own MIN_TOPUP_USD default — kept in
// sync manually rather than fetched, since it's just used for the
// client-side input's `min` attribute; the server enforces the real floor
// regardless of what the client sends.
export const MIN_TOPUP_USD = 10;

export async function startCheckout(amountUsd) {
  const token = await getAccessToken();
  if (!token) throw new Error("Sign in first.");

  const res = await fetch(CHECKOUT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ userAccessToken: token, amountUsd }),
  });

  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error("Couldn't start checkout.");
  }
  if (!res.ok || !data.url) {
    throw new Error(data.error || "Couldn't start checkout.");
  }
  window.location.href = data.url;
}
