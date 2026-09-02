// Supabase Edge Function: create-checkout-session
//
// Section D of the production punch list (billing). Starts a Stripe
// Checkout session for a one-time balance top-up — Hypha's model is a
// prepaid dollar balance (monetization outline doc, Section 14.1), not a
// recurring subscription, so this is `mode: "payment"`, not `mode:
// "subscription"`. Auto-reload (opt-in only, per 14.1) would reuse the
// saved payment method from this same Stripe customer in a later build —
// not part of this first pass.
//
// Same auth convention as rabbit-hole-proxy: the gateway-level
// Authorization header carries the anon key (so Supabase's own JWT check
// passes), and the REAL signed-in user's access token travels inside the
// JSON body as `userAccessToken`, verified here with
// supabase.auth.getUser(). Never trust a client-supplied user id directly.
//
// DEPLOY STEPS:
//   1. supabase functions new create-checkout-session
//   2. Replace the generated index.ts with this file's contents
//   3. supabase secrets set STRIPE_SECRET_KEY=sk_test_...  (or sk_live_... once ready)
//   4. supabase functions deploy create-checkout-session

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@17.5.0?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Hardcoded to the known deployed domain rather than trusting a
// client-supplied return URL — Stripe redirects the browser here after
// checkout, and accepting an arbitrary client-supplied origin would turn
// this into an open redirect. Override via secret if the domain changes.
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://hyfa-x.vercel.app";

// Matches the monetization outline doc's Section 14.1 ("minimum $10 to
// start, open-ended top-ups above that").
const MIN_TOPUP_USD = Number(Deno.env.get("MIN_TOPUP_USD") ?? "10");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY secret is not set on this function" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const stripe = new Stripe(stripeSecretKey, { httpClient: Stripe.createFetchHttpClient() });

    const body = await req.json();
    const { userAccessToken, amountUsd } = body;

    if (!userAccessToken) {
      return new Response(JSON.stringify({ error: "Sign in required." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: userData, error: userErr } = await supabase.auth.getUser(userAccessToken);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Sign in required." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;
    const email = userData.user.email ?? undefined;

    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount < MIN_TOPUP_USD) {
      return new Response(JSON.stringify({ error: `Minimum top-up is $${MIN_TOPUP_USD}.` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Reuse the same Stripe customer across top-ups (and, later, for
    // opt-in auto-reload's saved payment method) rather than creating a
    // fresh anonymous Stripe customer every time.
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .maybeSingle();

    let stripeCustomerId = profile?.stripe_customer_id ?? null;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userId },
      });
      stripeCustomerId = customer.id;
      await supabase.from("profiles").update({ stripe_customer_id: stripeCustomerId }).eq("id", userId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: stripeCustomerId,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Hypha balance top-up" },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      success_url: `${APP_ORIGIN}/?checkout=success`,
      cancel_url: `${APP_ORIGIN}/?checkout=cancel`,
      metadata: { supabase_user_id: userId },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("create-checkout-session: unexpected error", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
