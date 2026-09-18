// Supabase Edge Function: send-daily-digest
//
// Punch list Section E — a daily email, styled like a small slice of the
// hero page, mirroring its actual section structure AND its actual dark
// warm-brown palette (see App.jsx / the brand brief: "there is no light
// theme, the dark warm palette IS the brand") rather than a generic light
// "marketing email" look. Clicking any topic drops the reader straight
// into the app on that exact topic via the existing `?topic=` URL handler
// in App.jsx (no client changes needed for this at all — that handler
// already exists for any external link/bookmarklet wanting to hand a topic
// to the app).
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

// Same fields the hero page itself reads, in the SAME section order it
// renders them (see App.jsx's QUOTE_FIELD/TODAY→RIDDLE→TRENDING order) —
// kept as a literal copy here rather than a shared import, since edge
// functions in this project don't share code across function directories
// (each one is deployed independently by pasting its own file).
const QUOTE_FIELD = "Quote Of The Day";
const RIDDLE_FIELD = "Riddle";
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

// The app's actual color tokens (App.jsx / AccountMenu.jsx) — copied here
// for the same reason FIELD_LABELS above is a literal copy, not shared.
const COLOR_PAGE_BG = "#14100C";
const COLOR_CARD_BG = "#1F1811";
const COLOR_CHIP_BG = "#241B12";
const COLOR_CHIP_BORDER = "#4A3826";
const COLOR_TEXT_PRIMARY = "#F1E6D3";
const COLOR_TEXT_MUTED = "#B8A886";
const COLOR_TEXT_FAINT = "#A89478";
const COLOR_ACCENT = "#E3A73C";
const COLOR_BORDER_FAINT = "#3A2E20";

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

// Generic topic card (Trending/Today rows) — same "chip" treatment as the
// hero page's cards: a labeled uppercase kicker, the topic itself, then the
// teaser, on the app's actual chip background/border tokens rather than a
// light card.
function topicRowHtml(row: { field: string; topic: string; teaser: string }): string {
  const label = FIELD_LABELS[row.field] || row.field;
  const url = `${APP_ORIGIN}/?topic=${encodeURIComponent(row.topic)}`;
  return `
  <tr>
    <td style="padding:0 40px 12px;">
      <a href="${url}" style="display:block; text-decoration:none; background-color:${COLOR_CHIP_BG}; border:1px solid ${COLOR_CHIP_BORDER}; border-radius:16px; padding:16px;">
        <span style="display:block; font-family:'Courier New',monospace; font-size:10px; letter-spacing:1.5px; text-transform:uppercase; color:${COLOR_ACCENT}; font-weight:700; margin-bottom:4px;">${escapeHtml(label)}</span>
        <span style="display:block; font-size:16px; font-weight:600; color:${COLOR_TEXT_PRIMARY}; margin-bottom:4px;">${escapeHtml(row.topic)}</span>
        <span style="display:block; font-size:13px; line-height:1.5; color:${COLOR_TEXT_MUTED};">${escapeHtml(row.teaser)}</span>
      </a>
    </td>
  </tr>`;
}

// Quote Of The Day gets its own visual treatment rather than the generic
// topic card — same idea as the hero page's dedicated section (App.jsx),
// where the full quote and author are the whole point, not a label +
// teaser. `topic` is already the full quote text in quotation marks,
// `teaser` the author/attribution — see generate-trending-topics'
// quoteOfTheDayPrompt.
function quoteRowHtml(row: { topic: string; teaser: string }): string {
  const url = `${APP_ORIGIN}/?topic=${encodeURIComponent(row.topic)}`;
  return `
  <tr>
    <td style="padding:0 40px 12px;">
      <a href="${url}" style="display:block; text-decoration:none; background-color:${COLOR_CHIP_BG}; border:1px solid ${COLOR_CHIP_BORDER}; border-radius:16px; padding:20px;">
        <span style="display:block; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:17px; line-height:1.5; color:${COLOR_TEXT_PRIMARY}; margin-bottom:8px;">${escapeHtml(row.topic)}</span>
        <span style="display:block; font-size:13px; color:${COLOR_TEXT_MUTED};">${escapeHtml(row.teaser)}</span>
      </a>
    </td>
  </tr>`;
}

// "Riddle me this...." — same click-to-find-out card as the hero page's
// current design (see App.jsx: the multiple-choice guess was replaced with
// a single reveal card). Tapping it goes straight to the real answer, same
// as every other row. The trailing "...." mirrors the hero's exact display
// treatment (strip any trailing period the model wrote, then append the
// same four dots), not a difference between the two surfaces.
function riddleRowHtml(row: { topic: string; teaser: string }): string {
  const url = `${APP_ORIGIN}/?topic=${encodeURIComponent(row.topic)}`;
  const displayText = `${row.teaser.replace(/\.+\s*$/, "")}....`;
  return `
  <tr>
    <td style="padding:0 40px 12px;">
      <a href="${url}" style="display:block; text-decoration:none; background-color:${COLOR_CHIP_BG}; border:1px solid ${COLOR_CHIP_BORDER}; border-radius:16px; padding:20px;">
        <span style="display:block; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:16px; line-height:1.6; color:${COLOR_TEXT_PRIMARY};">${escapeHtml(displayText)}</span>
      </a>
    </td>
  </tr>`;
}

// One heading per hero-page section (Quote of the Day / Today / Riddle me
// this.... / Trending) instead of a single flat list under one generic
// title — same section names and order the hero page itself uses.
function sectionHeadingHtml(title: string): string {
  return `
  <tr>
    <td style="padding:0 40px 10px;">
      <span style="display:block; text-align:center; font-family:'Courier New',monospace; font-size:11px; letter-spacing:2px; text-transform:uppercase; color:${COLOR_TEXT_FAINT};">${escapeHtml(title)}</span>
    </td>
  </tr>`;
}

// Same "as of [date]" badge as the hero page, in the same spot — centered,
// above Quote of the Day, reflecting the whole batch's freshness rather
// than being scoped to one section (see App.jsx's mostRecentDate usage).
function asOfHtml(date: Date): string {
  const formatted = date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return `
  <tr>
    <td style="padding:0 40px 4px;">
      <span style="display:block; text-align:center; font-family:'Courier New',monospace; font-size:13px; color:${COLOR_TEXT_FAINT};">as of <span style="color:${COLOR_ACCENT}; font-weight:700;">${escapeHtml(formatted)}</span></span>
    </td>
  </tr>`;
}

// Same visual language as the hero page and the magic-link email template
// (dark header, logo, tagline, warm-brown chip cards) so this reads as the
// same product end to end, not a different "marketing email" voice grafted
// onto the same content.
function digestHtml(
  sections: {
    quote: { topic: string; teaser: string } | null;
    today: { field: string; topic: string; teaser: string }[];
    riddle: { topic: string; teaser: string } | null;
    trending: { field: string; topic: string; teaser: string }[];
  },
  asOfDate: Date | null,
  unsubscribeUrl: string
): string {
  const { quote, today, riddle, trending } = sections;
  const sectionsHtml = [
    asOfDate ? asOfHtml(asOfDate) : "",
    quote ? sectionHeadingHtml("Quote of the Day") + quoteRowHtml(quote) : "",
    today.length ? sectionHeadingHtml("Today") + today.map(topicRowHtml).join("\n") : "",
    riddle ? sectionHeadingHtml("Riddle me this....") + riddleRowHtml(riddle) : "",
    trending.length ? sectionHeadingHtml("Trending") + trending.map(topicRowHtml).join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLOR_PAGE_BG};">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:${COLOR_CARD_BG}; border-radius:16px; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <tr>
          <td bgcolor="${COLOR_PAGE_BG}" style="background-color:${COLOR_PAGE_BG}; padding:32px 40px; text-align:center;">
            <img src="${APP_ORIGIN}/hyfax-logo.png" width="120" alt="Hyfax" style="display:block; margin:0 auto; border:0; height:auto;" />
            <div style="margin-top:8px; font-family:'Courier New',monospace; font-size:10px; letter-spacing:3px; text-transform:uppercase; color:${COLOR_TEXT_FAINT};">
              always another thread
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 8px;">
            <h1 style="margin:0 0 8px; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:22px; line-height:1.3; color:${COLOR_TEXT_PRIMARY};">Today's threads</h1>
            <p style="margin:0 0 24px; font-size:14px; line-height:1.6; color:${COLOR_TEXT_MUTED};">Pick one — it drops you straight into the app.</p>
          </td>
        </tr>
        ${sectionsHtml}
        <tr>
          <td style="padding:16px 40px 32px; text-align:center;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td bgcolor="${COLOR_ACCENT}" style="background-color:${COLOR_ACCENT}; border-radius:999px;">
                  <a href="${APP_ORIGIN}" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:600; color:${COLOR_PAGE_BG}; text-decoration:none;">
                    Open Hyfax
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px; border-top:1px solid ${COLOR_BORDER_FAINT};">
            <p style="margin:0; font-size:12px; line-height:1.6; color:${COLOR_TEXT_FAINT};">
              You're getting this because your Hyfax account has the daily digest turned on.
              <a href="${unsubscribeUrl}" style="color:${COLOR_ACCENT};">Turn it off</a>.
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
    .in("field", [QUOTE_FIELD, RIDDLE_FIELD, ...TRENDING_FIELDS, ...TODAY_FIELDS])
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
  type Topic = { field: string; topic: string; teaser: string };
  const quote = latestByField.get(QUOTE_FIELD) ?? null;
  const riddle = latestByField.get(RIDDLE_FIELD) ?? null;
  const trending = TRENDING_FIELDS.map((f) => latestByField.get(f)).filter(Boolean) as Topic[];
  const today = TODAY_FIELDS.map((f) => latestByField.get(f)).filter(Boolean) as Topic[];
  const allTopics = [...(quote ? [quote] : []), ...today, ...(riddle ? [riddle] : []), ...trending];
  if (allTopics.length === 0) {
    return new Response(JSON.stringify({ error: "No topics available to send" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Same "as of" semantics as the hero page's mostRecentDate — the max
  // timestamp across the WHOLE fetched batch, not just one section, so a
  // partially-stale batch still shows the real freshest date rather than
  // an arbitrary section's.
  const asOfDate =
    topicRows && topicRows.length
      ? new Date(Math.max(...topicRows.map((r) => new Date(r.generated_at).getTime())))
      : null;

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
      await sendResendEmail(
        resendApiKey,
        recipient.email,
        "Today's threads on Hyfax",
        digestHtml({ quote, today, riddle, trending }, asOfDate, unsubscribeUrl)
      );
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

  return new Response(
    JSON.stringify({ sent, failed: errors.length, errors, topics: allTopics.map((t) => t.topic) }),
    { headers: { "Content-Type": "application/json" } }
  );
});
