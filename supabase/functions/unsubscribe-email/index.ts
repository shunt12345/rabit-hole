// Supabase Edge Function: unsubscribe-email
//
// One-click unsubscribe target for the daily digest's "Turn it off" link
// (see send-daily-digest) — a plain link click from an email client, so
// this has to work with NO Authorization header and no signed-in session
// at all. Proves the request is legitimate via an HMAC token instead:
// send-daily-digest computes HMAC-SHA256(EMAIL_UNSUB_SECRET, userId) into
// the link it sends; this recomputes the same value from the uid in the
// query string and only proceeds if they match. Nobody who doesn't already
// have a specific person's real digest email can produce a valid link for
// that person's uid.
//
// Deployed with --no-verify-jwt (like generate-trending-topics) since a
// bare link click carries no JWT at all — send-daily-digest's link
// includes the anon key as a query param (`apikey=...`) instead, which
// Supabase's function gateway accepts in place of an Authorization header.
//
// DEPLOY STEPS:
//   1. supabase functions new unsubscribe-email
//   2. Replace the generated index.ts with this file's contents
//   3. supabase secrets set EMAIL_UNSUB_SECRET=<same value used for send-daily-digest>
//   4. supabase functions deploy unsubscribe-email --no-verify-jwt

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://hyfax.app";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function unsubscribeToken(secret: string, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(userId));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function page(title: string, message: string): Response {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} — Hyfax</title>
  </head>
  <body style="margin:0; background-color:#14100C; color:#F1E6D3; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; text-align:center; padding:24px;">
    <div style="max-width:420px;">
      <img src="${APP_ORIGIN}/hyfax-logo.png" width="100" alt="Hyfax" style="margin:0 auto 24px; display:block;" />
      <h1 style="font-size:20px; margin:0 0 12px;">${title}</h1>
      <p style="font-size:14px; line-height:1.6; color:#C9B896;">${message}</p>
      <a href="${APP_ORIGIN}" style="display:inline-block; margin-top:20px; padding:10px 24px; border-radius:999px; background-color:#E3A73C; color:#14100C; text-decoration:none; font-size:14px; font-weight:600;">Back to Hyfax</a>
    </div>
  </body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

serve(async (req) => {
  const url = new URL(req.url);
  const uid = url.searchParams.get("uid");
  const token = url.searchParams.get("token");
  const unsubSecret = Deno.env.get("EMAIL_UNSUB_SECRET");

  if (!uid || !token || !unsubSecret) {
    return page("Link incomplete", "This unsubscribe link is missing something — try opening it again from the original email.");
  }

  const expected = await unsubscribeToken(unsubSecret, uid);
  if (expected !== token) {
    return page("Link not recognized", "This link doesn't check out, so nothing was changed. If you keep getting this, reply to the email and let us know.");
  }

  const { error } = await supabase.from("profiles").update({ feature_email: false }).eq("id", uid);
  if (error) {
    console.error("unsubscribe-email: failed to update profile", error);
    return page("Something went wrong", "Couldn't update your preference just now — try again in a bit.");
  }

  return page("You're unsubscribed", "The daily digest is now off for your account. You can turn it back on anytime from your account settings in the app.");
});
