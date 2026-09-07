// Section D of the production punch list (billing). Starts a Stripe
// Embedded Checkout session for a one-time balance top-up — mounted inline
// in AccountMenu.jsx via @stripe/react-stripe-js, instead of redirecting
// the browser to a checkout.stripe.com page. This app still never touches
// card details itself (Stripe hosts the actual fields in an iframe), so
// there's no PCI-scoped form to build here — just a client_secret handoff.
// See supabase/functions/create-checkout-session for the server side.
import { loadStripe } from "@stripe/stripe-js";
import { getAccessToken } from "./auth.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const CHECKOUT_URL = `${SUPABASE_URL}/functions/v1/create-checkout-session`;

// Matches create-checkout-session's own MIN_TOPUP_USD default — kept in
// sync manually rather than fetched, since it's just used for the
// client-side input's `min` attribute; the server enforces the real floor
// regardless of what the client sends.
export const MIN_TOPUP_USD = 10;

// Created once at module load, not inside a component render — loadStripe
// fetches Stripe.js from js.stripe.com the first time it's called, and
// Stripe's own docs warn against re-triggering that on every render.
export const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

// Passed as EmbeddedCheckoutProvider's `fetchClientSecret` option — Stripe's
// embedded-checkout library calls this itself when it mounts, rather than
// this app fetching and holding the secret.
export async function fetchCheckoutClientSecret(amountUsd) {
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
  if (!res.ok || !data.clientSecret) {
    throw new Error(data.error || "Couldn't start checkout.");
  }
  return data.clientSecret;
}
