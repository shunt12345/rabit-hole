// Supabase Edge Function: stripe-webhook
//
// Section D of the production punch list (billing). Stripe calls this
// directly (never the browser), so it must NOT go through the platform's
// normal JWT gate — there's no Supabase user token on this request at all,
// only Stripe's own signature. Same posture as generate-trending-topics's
// cron secret: `verify_jwt = false` in supabase/config.toml, and if
// deploying by hand through the Dashboard rather than the CLI, also
// disable "Enforce JWT Verification" for this function there directly.
//
// Only `checkout.session.completed` is handled — that's the one event
// that means "a top-up actually succeeded." Everything else is
// acknowledged (200) and ignored, since an unhandled event type isn't an
// error, just not something this app currently reacts to.
//
// Idempotency: Stripe retries webhook deliveries on anything other than a
// fast 2xx, so the same session can arrive more than once. The insert into
// billing_transactions has a unique constraint on stripe_session_id — a
// duplicate delivery hits that constraint, and the balance is never
// credited twice for one payment.
//
// DEPLOY STEPS:
//   1. supabase functions new stripe-webhook
//   2. Replace the generated index.ts with this file's contents
//   3. In the Stripe Dashboard: Developers -> Webhooks -> Add endpoint,
//      pointing at this function's URL, subscribed to
//      checkout.session.completed. Copy the signing secret it gives you.
//   4. supabase secrets set STRIPE_SECRET_KEY=sk_test_...
//      supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
//   5. Add `[functions.stripe-webhook]\nverify_jwt = false` to
//      supabase/config.toml (already done in this repo) — if deploying by
//      hand via the Dashboard instead of the CLI, also flip "Enforce JWT
//      Verification" off for this function there, since the CLI config
//      file isn't read on a Dashboard-only deploy.
//   6. supabase functions deploy stripe-webhook

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@17.5.0?target=deno";
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!stripeSecretKey || !webhookSecret) {
      console.error("stripe-webhook: STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET not set");
      return new Response("webhook not configured", { status: 500 });
    }
    const stripe = new Stripe(stripeSecretKey, { httpClient: Stripe.createFetchHttpClient() });

    const signature = req.headers.get("Stripe-Signature");
    const body = await req.text();
    if (!signature) {
      return new Response("missing Stripe-Signature header", { status: 400 });
    }

    // constructEventAsync (not the sync constructEvent) + an explicit
    // SubtleCrypto provider — Deno's crypto is Web Crypto (async-only),
    // unlike Node's, which is what Stripe's sync signature check assumes.
    let event;
    try {
      event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        webhookSecret,
        undefined,
        Stripe.createSubtleCryptoProvider()
      );
    } catch (err) {
      console.error("stripe-webhook: signature verification failed", err);
      return new Response("invalid signature", { status: 400 });
    }

    if (event.type !== "checkout.session.completed") {
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const session = event.data.object as {
      id: string;
      amount_total: number | null;
      payment_intent: string | null;
      metadata?: Record<string, string>
    };
    const userId = session.metadata?.supabase_user_id;
    const amountUsd = (session.amount_total ?? 0) / 100;

    if (!userId || amountUsd <= 0) {
      console.error("stripe-webhook: checkout.session.completed missing supabase_user_id or amount", session.id);
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { error: insertErr } = await supabase.from("billing_transactions").insert({
      user_id: userId,
      stripe_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent,
      amount_usd: amountUsd,
      status: "completed",
    });

    if (insertErr) {
      // 23505 = unique_violation — this session was already processed by
      // an earlier delivery of the same webhook. Not an error, just a
      // duplicate; acknowledge without crediting the balance again.
      if (insertErr.code === "23505") {
        return new Response(JSON.stringify({ received: true, duplicate: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      console.error("stripe-webhook: failed to record transaction, not crediting balance", insertErr);
      return new Response("failed to record transaction", { status: 500 });
    }

    const { error: creditErr } = await supabase.rpc("credit_balance", {
      p_user_id: userId,
      p_amount: amountUsd,
    });
    if (creditErr) {
      console.error("stripe-webhook: failed to credit balance", creditErr, session.id);
      return new Response("failed to credit balance", { status: 500 });
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("stripe-webhook: unexpected error", e);
    return new Response("unexpected error", { status: 500 });
  }
});
