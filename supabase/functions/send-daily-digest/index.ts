// Supabase Edge Function: send-daily-digest
//
// Punch list Section E, finally built — a daily email, styled like a small
// slice of the hero page, listing today's Trending + Today topics as
// clickable links. Clicking one drops the reader straight into the app on
// that exact topic via the existing `?topic=` URL handler in App.jsx (no
// client changes needed for this at all — that handler already exists for
// any external link/bookmarklet wanting to hand a topic to the app).
//
// Cron-only, NOT reachable from a browser — same shared-secret pattern as
// generate-trending-topics (checked against CRON_SECRET), not the anon key,
// since this costs a real Resend send per recipient and should only ever
// fire on schedule.
//
// Recipients: every signed-in profile with feature_email = true (the
// existing digest toggle, defaults ON per migration 0013) and a real email
// on file. Anonymous visitors have no email at all, so they're never in
// scope for this — the digest is an account-level feature by nature.
//
// DEPLOY STEPS:
//   1. supabase functions new send-daily-digest
//   2. Replace the generated index.ts with this file's contents
//   3. Get a Resend API key (resend.com -> API Keys) — the same key used
//      for Supabase Auth's SMTP setup works fine here too, or make a new
//      one; either way:
//      supabase secrets set RESEND_API_KEY=re_...
//   4. Pick any random secret string for one-click unsubscribe links, then:
//      supabase secrets set EMAIL_UNSUB_SECRET=<that secret>
//      (unsubscribe-email needs the SAME value — see its own deploy steps)
//   5. supabase functions deploy send-daily-digest --no-verify-jwt
//      (cron-only, not reachable with a Supabase JWT — see config.toml,
//      same as generate-trending-topics)
//   6. Run the migration that schedules the daily cron job.

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://hyfax.app";
// Sender identity — must be an address on a domain verified in Resend
// (hyfax.app already is, from the magic-link SMTP setup). Override via
// secret without a code change if you want a different from-name/address.
const DIGEST_FROM = Deno.env.get("DIGEST_FROM_EMAIL") ?? "Hyfax <hello@hyfax.app>";

// Same three trending fields + three date-anchored fields the hero page
// itself reads (see App.jsx's NEWS_FIELDS/SPECIAL_FIELDS) — kept as a
// literal copy here rather than a shared import, since edge functions in
// this project don't share code across function directories (each one is
// deployed independently by pasting its own file).
const TRENDING_FIELDS = ["Trending 1", "Trending 2", "Trending Wildcard"];
const TODAY_FIELDS = ["National Day", "This Day In History", "Word Of The Day"];
const FIELD_LABELS: Record<string, string> = {
  "Trending 1": "Trending",
  "Trending 2": "Trending",
  "Trending Wildcard": "Wildcard",
  "National Day": "National Day",
  "This Day In History": "This Day In History",
  "Word Of The Day": "Word Of The Day",
};

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Hex-encoded HMAC-SHA256 of the user id — lets the unsubscribe link prove
// "this really came from an email we sent this specific user" without a
// database round trip or a stored per-user token column. unsubscribe-email
// recomputes this same value from the uid in the link and compares.
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

async function sendResendEmail(apiKey: string, to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: DIGEST_FROM, to, subject, html }),
  });
  if (!res.ok) {
    throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

function topicRowHtml(row: { field: string; topic: string; teaser: string }): string {
  const label = FIELD_LABELS[row.field] || row.field;
  const url = `${APP_ORIGIN}/?topic=${encodeURIComponent(row.topic)}`;
  return `
  <tr>
    <td style="padding:0 40px 16px;">
      <a href="${url}" style="display:block; text-decoration:none; border:1px solid #EDE6D6; border-radius:12px; padding:16px;">
        <span style="display:block; font-family:'Courier New',monospace; font-size:10px; letter-spacing:1.5px; text-transform:uppercase; color:#B8863A; font-weight:700; margin-bottom:4px;">${escapeHtml(label)}</span>
        <span style="display:block; font-size:16px; font-weight:600; color:#14100C; margin-bottom:4px;">${escapeHtml(row.topic)}</span>
        <span style="display:block; font-size:13px; line-height:1.5; color:#6B5B45;">${escapeHtml(row.teaser)}</span>
      </a>
    </td>
  </tr>`;
}

// Same visual language as the magic-link email template (dark header,
// logo, tagline) so this reads as the same product, not a different
// "marketing email" voice.
function digestHtml(topics: { field: string; topic: string; teaser: string }[], unsubscribeUrl: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4EFE6;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#FFFFFF; border-radius:12px; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <tr>
          <td bgcolor="#14100C" style="background-color:#14100C; padding:32px 40px; text-align:center;">
            <img src="${APP_ORIGIN}/hyfax-logo.png" width="120" alt="Hyfax" style="display:block; margin:0 auto; border:0; height:auto;" />
            <div style="margin-top:8px; font-family:'Courier New',monospace; font-size:10px; letter-spacing:3px; text-transform:uppercase; color:#A89478;">
              always another thread
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 8px;">
            <h1 style="margin:0 0 8px; font-size:20px; line-height:1.3; color:#14100C;">Today's threads</h1>
            <p style="margin:0 0 24px; font-size:14px; line-height:1.6; color:#4A4038;">Pick one — it drops you straight into the app.</p>
          </td>
        </tr>
        ${topics.map(topicRowHtml).join("\n")}
        <tr>
          <td style="padding:8px 40px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td bgcolor="#E3A73C" style="background-color:#E3A73C; border-radius:999px;">
                  <a href="${APP_ORIGIN}" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:600; color:#14100C; text-decoration:none;">
                    Open Hyfax
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px; border-top:1px solid #EDE6D6;">
            <p style="margin:0; font-size:12px; line-height:1.6; color:#A89478;">
              You're getting this because your Hyfax account has the daily digest turned on.
              <a href="${unsubscribeUrl}" style="color:#B8863A;">Turn it off</a>.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const unsubSecret = Deno.env.get("EMAIL_UNSUB_SECRET");
  if (!resendApiKey || !unsubSecret) {
    return new Response(
      JSON.stringify({ error: "RESEND_API_KEY and/or EMAIL_UNSUB_SECRET secret is not set on this function" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Latest row per field — same "most recent per named field" semantics as
  // the client's latestByField, just expressed as SQL here.
  const { data: topicRows, error: topicsError } = await supabase
    .from("trending_topics_cache")
    .select("field, topic, teaser, generated_at")
    .in("field", [...TRENDING_FIELDS, ...TODAY_FIELDS])
    .order("generated_at", { ascending: false });
  if (topicsError) {
    return new Response(JSON.stringify({ error: `Failed to read topics: ${topicsError.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const latestByField = new Map<string, { field: string; topic: string; teaser: string }>();
  for (const row of topicRows || []) {
    if (!latestByField.has(row.field)) latestByField.set(row.field, row);
  }
  const topics = [...TRENDING_FIELDS, ...TODAY_FIELDS].map((f) => latestByField.get(f)).filter(Boolean) as {
    field: string;
    topic: string;
    teaser: string;
  }[];
  if (topics.length === 0) {
    return new Response(JSON.stringify({ error: "No topics available to send" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: recipients, error: recipientsError } = await supabase
    .from("profiles")
    .select("id, email")
    .eq("feature_email", true)
    .not("email", "is", null);
  if (recipientsError) {
    return new Response(JSON.stringify({ error: `Failed to read recipients: ${recipientsError.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let sent = 0;
  const errors: string[] = [];
  for (const recipient of recipients || []) {
    try {
      const token = await unsubscribeToken(unsubSecret, recipient.id);
      const unsubscribeUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/unsubscribe-email?uid=${recipient.id}&token=${token}&apikey=${Deno.env.get("SUPABASE_ANON_KEY")}`;
      await sendResendEmail(resendApiKey, recipient.email, "Today's threads on Hyfax", digestHtml(topics, unsubscribeUrl));
      sent++;
      // Resend's rate limit is generous but not infinite — a small pause
      // between sequential sends costs nothing at today's scale and
      // avoids ever bursting past it as the list grows.
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      console.error(`send-daily-digest: failed to send to ${recipient.id}`, e);
      errors.push(`${recipient.id}: ${e}`);
    }
  }

  return new Response(JSON.stringify({ sent, failed: errors.length, errors, topics: topics.map((t) => t.topic) }), {
    headers: { "Content-Type": "application/json" },
  });
});
