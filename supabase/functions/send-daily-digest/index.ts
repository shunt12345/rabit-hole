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
// Every link back to the app is tagged as coming from this email, so
// /admin can tell digest clicks apart from direct visits.
const EMAIL_UTM = "utm_source=email&utm_medium=email&utm_campaign=daily-digest";
// utm_content names the section the link sits in (quote, riddle, trending,
// …), so /admin can show which parts of the email people click.
function appUrl(params = "", section = "open-hyfax"): string {
  return `${APP_ORIGIN}/?${params ? `${params}&` : ""}${EMAIL_UTM}&utm_content=${section}`;
}
// "Trending 1" → "trending", "This Day In History" → "this-day-in-history".
function sectionOf(field: string): string {
  return field.replace(/\s*\d+$/, "").toLowerCase().replace(/[^a-z]+/g, "-");
}

const DIGEST_FROM = Deno.env.get("DIGEST_FROM_EMAIL") ?? "Hyfax <hello@hyfax.app>";

// Same fields the hero page itself reads, in the SAME section order it
// renders them (see App.jsx's QUOTE_FIELD/TODAY→PERSPECTIVE→RIDDLE→TRENDING
// order) — kept as a literal copy here rather than a shared import, since edge
// functions in this project don't share code across function directories
// (each one is deployed independently by pasting its own file).
const QUOTE_FIELD = "Quote Of The Day";
const RIDDLE_FIELD = "Riddle";
const PERSPECTIVE_FIELD = "Perspective";
const TRENDING_FIELDS = ["Trending 1", "Trending 2"];
const TODAY_FIELDS = ["This Day In History", "Word Of The Day"];
// How long a pick stays on the hero page (MAX_STALE_HOURS in
// src/lib/heroPicks.js); the email leaves out anything older too.
const MAX_STALE_HOURS = 36;
const FIELD_LABELS: Record<string, string> = {
  "Trending 1": "Trending",
  "Trending 2": "Trending",
  "This Day In History": "This Day In History",
  "Word Of The Day": "Word Of The Day",
  Perspective: "Perspective",
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

async function sendResendEmail(apiKey: string, to: string, subject: string, html: string, text: string, unsubscribeUrl: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: DIGEST_FROM,
      to,
      subject,
      html,
      text,
      // Gmail expects these from anyone sending a daily list: they give the
      // reader its own Unsubscribe button, and one-click POSTs to the same
      // link as the footer's "Turn it off" (unsubscribe-email reads uid and
      // token from the query string whatever the method).
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
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
  const url = appUrl(`topic=${encodeURIComponent(row.topic)}`, sectionOf(row.field));
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
  const url = appUrl(`topic=${encodeURIComponent(row.topic)}`, "quote");
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
// The guessing-game riddle (riddle_game, migration 0056), the way the game
// opens on the hero page: "What am I?", the answer's letters as blank
// blocks, and only the first (hardest) clue — the rest are revealed in the
// game. Links to the riddle on the hero page (?play=riddle scrolls to it)
// rather than to the answer, which would give it away.
type RiddleClue = { title: string; line?: string; teaser?: string };

// Same as src/lib/riddle.js clueLine: the clue's riddle line, or for an
// older riddle its description with the answer blanked out.
function clueLine(clue: RiddleClue, topic: string, answers: string[]): string {
  if (clue.line?.trim()) return clue.line.trim();
  let text = String(clue.teaser || clue.title || "");
  const phrases = [topic, ...answers].map((a) => String(a || "").trim()).filter((a) => a.length >= 3).sort((x, y) => y.length - x.length);
  for (const phrase of phrases) {
    const pattern = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    text = text.replace(new RegExp(`\\b${pattern}(e?s|y|ed|ing)?\\b`, "gi"), "___");
  }
  return text;
}

function riddleGameRowHtml(topic: string, clues: RiddleClue[], answers: string[]): string {
  const url = appUrl("play=riddle", "riddle");
  // A leading "The"/"A"/"An" isn't part of the blocks, as in the game.
  const blocks = topic
    .trim()
    .replace(/^(the|a|an)\s+(?=\S)/i, "")
    .split(/\s+/)
    .map((word) =>
      [...word]
        .map((ch) =>
          /[\p{L}\p{N}]/u.test(ch)
            ? `<span style="display:inline-block; width:20px; height:24px; margin-right:4px; border:2px solid #C9B896; border-radius:5px; background-color:#2E2318;"></span>`
            : `<span style="display:inline-block; margin-right:4px; color:${COLOR_TEXT_MUTED};">${escapeHtml(ch)}</span>`
        )
        .join("")
    )
    .join(`<span style="display:inline-block; width:12px;"></span>`);
  return `
  <tr>
    <td style="padding:0 40px 12px;">
      <a href="${url}" style="display:block; text-decoration:none; background-color:${COLOR_CHIP_BG}; border:1px solid ${COLOR_CHIP_BORDER}; border-radius:16px; padding:20px;">
        <span style="display:block; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:22px; color:${COLOR_TEXT_PRIMARY}; margin-bottom:12px;">What am I?</span>
        <span style="display:block; margin-bottom:12px; line-height:24px;">${blocks}</span>
        <span style="display:block; font-size:15px; line-height:1.5; color:${COLOR_TEXT_PRIMARY};"><span style="font-family:'Courier New',monospace; font-size:11px; color:${COLOR_TEXT_MUTED}; padding-right:10px;">1</span>${escapeHtml(clueLine(clues[0], topic, answers))}</span>
        <span style="display:block; margin-top:12px; font-size:14px; font-weight:600; color:${COLOR_ACCENT};">Play today's riddle</span>
      </a>
    </td>
  </tr>`;
}

function riddleRowHtml(row: { topic: string; teaser: string; riddle_game?: { clues?: RiddleClue[]; answers?: string[] } | null }): string {
  const clues = row.riddle_game?.clues;
  if (Array.isArray(clues) && clues.length) return riddleGameRowHtml(row.topic, clues, row.riddle_game?.answers || []);
  const url = appUrl(`topic=${encodeURIComponent(row.topic)}`, "riddle");
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

// Same date badge as the hero page, in the same spot — centered, above
// Quote of the Day, reflecting the whole batch rather than being scoped to
// one section (see App.jsx's mostRecentDate usage). Just the date, larger,
// matching the hero page (no "as of").
function asOfHtml(date: Date): string {
  const formatted = date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return `
  <tr>
    <td style="padding:0 40px 4px;">
      <span style="display:block; text-align:center; font-family:'Courier New',monospace; font-size:18px; color:${COLOR_ACCENT}; font-weight:700;">${escapeHtml(formatted)}</span>
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
    perspective: { field: string; topic: string; teaser: string } | null;
    riddle: { topic: string; teaser: string; riddle_game?: { clues?: RiddleClue[]; answers?: string[] } | null } | null;
    trending: { field: string; topic: string; teaser: string }[];
  },
  asOfDate: Date | null,
  unsubscribeUrl: string,
  reason: string
): string {
  const { quote, today, perspective, riddle, trending } = sections;
  // Its own order (below), not the hero page's: the email is a daily
  // ritual for people who already know Hyfax, so the riddle leads. Generic topicRowHtml card, same as Today's own
  // rows, rather than a bespoke treatment like quoteRowHtml/riddleRowHtml
  // get — those two need custom layout because their "topic" IS the full
  // quote/withheld riddle text; Perspective's shape (short label + teaser)
  // is the same as every other plain topic card.
  const sectionsHtml = [
    // The riddle leads (the daily reason to open it), then Trending's
    // "why it matters", Today and Perspective, and the quote signs off.
    asOfDate ? asOfHtml(asOfDate) : "",
    riddle ? sectionHeadingHtml("Riddle me this....") + riddleRowHtml(riddle) : "",
    trending.length ? sectionHeadingHtml("Trending") + trending.map(topicRowHtml).join("\n") : "",
    today.length ? sectionHeadingHtml("Today") + today.map(topicRowHtml).join("\n") : "",
    perspective ? sectionHeadingHtml("Perspective") + topicRowHtml(perspective) : "",
    quote ? sectionHeadingHtml("Quote of the Day") + quoteRowHtml(quote) : "",
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
              thinking with threads
            </div>
            <div style="margin-top:18px; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:20px; line-height:1.35; color:${COLOR_TEXT_PRIMARY};">
              Problem solving isn't linear.<br />Neither is your learning.
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 0; font-size:0; line-height:0;">&nbsp;</td>
        </tr>
        ${sectionsHtml}
        <tr>
          <td style="padding:16px 40px 32px; text-align:center;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td bgcolor="${COLOR_ACCENT}" style="background-color:${COLOR_ACCENT}; border-radius:999px;">
                  <a href="${appUrl()}" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:600; color:${COLOR_PAGE_BG}; text-decoration:none;">
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
              ${escapeHtml(reason)}
              <a href="${unsubscribeUrl}" style="color:${COLOR_ACCENT};">Turn it off</a>.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

type DigestSections = Parameters<typeof digestHtml>[0];

// Plain-text twin of digestHtml, sent alongside it: an HTML-only email
// reads as marketing to Gmail, and some readers prefer text anyway.
function digestText(sections: DigestSections, asOfDate: Date | null, unsubscribeUrl: string, reason: string): string {
  const { quote, today, perspective, riddle, trending } = sections;
  const topicUrl = (topic: string, section: string) => appUrl(`topic=${encodeURIComponent(topic)}`, section);
  const card = (row: { field: string; topic: string; teaser: string }) =>
    `${row.topic}\n${row.teaser}\n${topicUrl(row.topic, sectionOf(row.field))}`;
  const parts: string[] = ["Hyfax: thinking with threads"];
  if (asOfDate) parts.push(asOfDate.toLocaleDateString("en-US", { month: "long", day: "numeric" }));
  if (riddle) {
    const clues = riddle.riddle_game?.clues;
    parts.push(
      Array.isArray(clues) && clues.length
        ? `RIDDLE ME THIS\nWhat am I? ${clueLine(clues[0], riddle.topic, riddle.riddle_game?.answers || [])}\nPlay today's riddle: ${appUrl("play=riddle", "riddle")}`
        : `RIDDLE ME THIS\n${riddle.teaser}\n${topicUrl(riddle.topic, "riddle")}`
    );
  }
  if (trending.length) parts.push(`TRENDING\n${trending.map(card).join("\n\n")}`);
  if (today.length) parts.push(`TODAY\n${today.map(card).join("\n\n")}`);
  if (perspective) parts.push(`PERSPECTIVE\n${card(perspective)}`);
  if (quote) parts.push(`QUOTE OF THE DAY\n"${quote.topic}"\n${quote.teaser}\n${topicUrl(quote.topic, "quote")}`);
  parts.push(`Open Hyfax: ${appUrl()}`);
  parts.push(`${reason} Turn it off: ${unsubscribeUrl}`);
  return parts.join("\n\n");
}

// The subject is a short affirmation about learning, one per day of the
// year in turn, so it changes daily (the same subject every day is what
// makes an email look like a newsletter blast) without a lineup to manage.
const SUBJECT_AFFIRMATIONS = [
  "Every question you ask makes you sharper",
  "Curiosity is a skill, and you're building it",
  "Small lessons add up to big understanding",
  "You don't have to know everything, just the next thread",
  "A stuck problem is just one you haven't circled yet",
  "Today is a good day to learn something unexpected",
  "The best answers start with better questions",
  "Learning a little every day is how experts are made",
  "Your mind grows every time you follow a thread",
  "Not knowing yet is where learning begins",
  "Every idea connects to another, keep pulling",
  "You're smarter today than you were yesterday",
  "Good problem solvers wander before they decide",
  "Five curious minutes can change how you see things",
  "Confusion is the feeling of your brain getting stronger",
  "The more you learn, the more you can connect",
  "Wonder is worth making time for",
  "Every expert was once a beginner who kept going",
  "A new perspective is the fastest way past a wall",
  "Keep asking why, it's how understanding grows",
  "Knowledge compounds, a little today goes a long way",
  "The answer you need may be one thread away",
  "Learning is the one habit you'll never regret",
  "Your questions are worth chasing",
  "Thinking sideways is still thinking forward",
  "Every day holds something worth understanding",
  "Better thinking starts with a single curious step",
  "The world gets more interesting the more you know",
  "You get better at learning by learning",
  "Follow your curiosity, it knows the way",
  "There's always another thread worth pulling",
];
function digestSubject(asOfDate: Date | null): string {
  const d = asOfDate || new Date();
  const dayOfYear = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
  return SUBJECT_AFFIRMATIONS[dayOfYear % SUBJECT_AFFIRMATIONS.length];
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

  // Approved, already-public picks; the pick per field is chosen below, by
  // the same rule as the hero page (src/lib/heroPicks.js). Explicitly
  // scoped to status='approved' (see migration 0045) even though this
  // function uses the service-role key, which bypasses the RLS policy
  // that enforces the same thing for the anon-key hero page — nothing
  // pending review should ever go out in an email either, and service
  // role sees everything regardless of RLS, so this filter is the only
  // thing enforcing that here.
  const { data: topicRows, error: topicsError } = await supabase
    .from("trending_topics_cache")
    .select("field, topic, teaser, generated_at, publish_at, riddle_game")
    .in("field", [QUOTE_FIELD, RIDDLE_FIELD, PERSPECTIVE_FIELD, ...TRENDING_FIELDS, ...TODAY_FIELDS])
    .eq("status", "approved")
    // Same "not public until its publish time" rule as the hero page's
    // read policy (migration 0053).
    .or(`publish_at.is.null,publish_at.lte.${new Date().toISOString()}`)
    // Bounded, so the read never hits the API's row cap as picks pile up; a
    // pick goes live within days of being generated.
    .gte("generated_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
  if (topicsError) {
    return new Response(JSON.stringify({ error: `Failed to read topics: ${topicsError.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  // The hero page's rule, so the email shows exactly the picks on the site:
  // per field, the pick that went live most recently (its publish_at, or
  // generated_at for a row without one, such as a hand-added seed), and
  // none older than 36 hours — a field with no fresh pick is left out, the
  // way the hero page drops its card.
  const liveSince = (r: { publish_at: string | null; generated_at: string }) => new Date(r.publish_at || r.generated_at).getTime();
  const freshSince = Date.now() - MAX_STALE_HOURS * 60 * 60 * 1000;
  const latestByField = new Map<string, { field: string; topic: string; teaser: string; publish_at: string | null; generated_at: string; riddle_game?: { clues?: RiddleClue[]; answers?: string[] } | null }>();
  for (const row of topicRows || []) {
    if (liveSince(row) < freshSince) continue;
    const best = latestByField.get(row.field);
    if (!best || liveSince(row) > liveSince(best)) latestByField.set(row.field, row);
  }
  type Topic = { field: string; topic: string; teaser: string };
  const quote = latestByField.get(QUOTE_FIELD) ?? null;
  const riddle = latestByField.get(RIDDLE_FIELD) ?? null;
  const perspective = latestByField.get(PERSPECTIVE_FIELD) ?? null;
  const trending = TRENDING_FIELDS.map((f) => latestByField.get(f)).filter(Boolean) as Topic[];
  const today = TODAY_FIELDS.map((f) => latestByField.get(f)).filter(Boolean) as Topic[];
  const allTopics = [
    ...(quote ? [quote] : []),
    ...today,
    ...(perspective ? [perspective] : []),
    ...(riddle ? [riddle] : []),
    ...trending,
  ];
  if (allTopics.length === 0) {
    return new Response(JSON.stringify({ error: "No topics available to send" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Same as the hero page's date badge (mostRecentDate): the latest time a
  // pick went live, so the badge shows the day the batch is for rather than
  // the day it was generated.
  const asOfDate =
    latestByField.size ? new Date(Math.max(...[...latestByField.values()].map(liveSince))) : null;

  const { data: accountRows, error: recipientsError } = await supabase
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
  // Plus the email-only sign-ups who confirmed (digest-subscribe), minus
  // any address an account already gets it at.
  const { data: subscriberRows, error: subscribersError } = await supabase
    .from("digest_subscribers")
    .select("id, email")
    .eq("status", "confirmed");
  if (subscribersError) console.error("send-daily-digest: failed to read subscribers", subscribersError);

  const functionsUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  type Recipient = { id: string; email: string; unsubscribeUrl: string; reason: string };
  const recipients: Recipient[] = [];
  const seen = new Set<string>();
  for (const r of accountRows || []) {
    seen.add(String(r.email).toLowerCase());
    const token = await unsubscribeToken(unsubSecret, r.id);
    recipients.push({
      id: r.id,
      email: r.email,
      unsubscribeUrl: `${functionsUrl}/unsubscribe-email?uid=${r.id}&token=${token}&apikey=${anonKey}`,
      reason: "You're getting this because your Hyfax account has the daily digest turned on.",
    });
  }
  for (const r of subscriberRows || []) {
    if (seen.has(String(r.email).toLowerCase())) continue;
    seen.add(String(r.email).toLowerCase());
    const token = await unsubscribeToken(unsubSecret, `subscriber:${r.id}`);
    recipients.push({
      id: `subscriber:${r.id}`,
      email: r.email,
      unsubscribeUrl: `${functionsUrl}/digest-subscribe?unsub=${r.id}&token=${token}&apikey=${anonKey}`,
      reason: "You're getting this because you signed up for Hyfax's daily threads.",
    });
  }

  const sections = { quote, today, perspective, riddle, trending };
  const subject = digestSubject(asOfDate);
  let sent = 0;
  const errors: string[] = [];
  for (const recipient of recipients) {
    try {
      const { unsubscribeUrl, reason } = recipient;
      await sendResendEmail(
        resendApiKey,
        recipient.email,
        subject,
        digestHtml(sections, asOfDate, unsubscribeUrl, reason),
        digestText(sections, asOfDate, unsubscribeUrl, reason),
        unsubscribeUrl
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
