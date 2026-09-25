// Supabase Edge Function: report-reddit-conversion
//
// Server-side half of Reddit Ads conversion tracking (see src/lib/
// redditPixel.js for the browser-side pixel that fires the same events).
// The browser pixel alone silently drops a real chunk of conversions — ad
// blockers, Safari's ITP, and privacy-focused browsers all commonly block
// it — so Reddit's Conversions API (CAPI) exists specifically as a
// server-to-server mirror that doesn't depend on the visitor's browser
// cooperating. Both fire the SAME event with the SAME conversion_id, and
// Reddit dedupes them on their end (see the Deduplication docs) rather
// than double-counting one real conversion.
//
// Self-contained like every other function in this project (no shared
// imports across functions, so each one can be redeployed independently)
// — see rabbit-hole-proxy-v2 for getClientIp/corsHeadersFor, duplicated
// here rather than imported.
//
// Request/response shape confirmed against Reddit's own official
// server-side GTM tag template (github.com/reddit/reddit-ss-gtm-template),
// not a third-party guess — that repo is Reddit's own reference
// implementation of exactly this API call, so it's the closest thing to
// authoritative documentation short of the (mostly JS-rendered, hard to
// scrape) Ads Help Center pages.
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const ALLOWED_ORIGINS = (
  Deno.env.get("ALLOWED_ORIGINS") ?? "https://hyfax.app,https://hyfa-x.vercel.app,http://localhost:5173,http://localhost:5183"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function corsHeadersFor(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

// Same extraction as rabbit-hole-proxy-v2's getClientIp — Deno Deploy (what
// Supabase Edge Functions run on) sets x-forwarded-for to a comma-separated
// list with the real originating client first.
function getClientIp(req: Request): string | null {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip");
}

// Reddit's API accepts either a raw or a pre-hashed email under the same
// `user.email` key (it auto-detects a 64-char hex string as already
// hashed) — hashing it here rather than sending the raw address is the
// more privacy-conscious of the two accepted forms, and costs nothing
// since Web Crypto is built into Deno.
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Only the events this app actually reports — extend as more funnel steps
// get tracked (see the mushroom/mind-expansion ad campaign this was built
// for). Validated against a fixed set rather than trusting the client's
// string verbatim, same posture as nodeType in rabbit-hole-proxy-v2.
const VALID_EVENT_TYPES = new Set(["SignUp"]);

const REDDIT_PIXEL_ID = Deno.env.get("REDDIT_PIXEL_ID");
const REDDIT_CONVERSION_TOKEN = Deno.env.get("REDDIT_CONVERSION_TOKEN");
// Set only for verifying new integration work in Reddit's Events Manager
// test tool (it gives you this literal string) — never set in production,
// since a real test_id makes Reddit treat every event as a test and not
// count it toward real campaign optimization.
const REDDIT_TEST_ID = Deno.env.get("REDDIT_TEST_ID");

serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!REDDIT_PIXEL_ID || !REDDIT_CONVERSION_TOKEN) {
    // Not configured yet (e.g. before the Reddit campaign launches) — fail
    // open and quiet rather than error, since the client fires this
    // fire-and-forget and nothing about the actual sign-up should ever
    // depend on ad tracking being wired up.
    return new Response(JSON.stringify({ ok: false, reason: "not_configured" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const conversionId = typeof body?.conversionId === "string" ? body.conversionId.trim() : "";
    const eventType = typeof body?.eventType === "string" ? body.eventType.trim() : "";
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!conversionId || !VALID_EVENT_TYPES.has(eventType)) {
      return new Response(JSON.stringify({ error: "invalid conversion payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const user: Record<string, string> = {
      ip_address: getClientIp(req) ?? "",
      user_agent: req.headers.get("user-agent") ?? "",
    };
    if (email) user.email = await sha256Hex(email);

    const redditRes = await fetch(`https://ads-api.reddit.com/api/v3/pixels/${REDDIT_PIXEL_ID}/conversion_events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${REDDIT_CONVERSION_TOKEN}`,
      },
      body: JSON.stringify({
        data: {
          ...(REDDIT_TEST_ID ? { test_id: REDDIT_TEST_ID } : {}),
          events: [
            {
              event_at: Date.now(),
              action_source: "WEBSITE",
              event_source_url: req.headers.get("referer") || "https://hyfax.app/",
              type: { tracking_type: eventType },
              metadata: { conversion_id: conversionId },
              user,
            },
          ],
          partner: "hyfax-direct-api",
          partner_version: "1.0.0",
        },
      }),
    });

    if (!redditRes.ok) {
      // Log for visibility but still return 200 to the client — same
      // fail-quiet posture as the not-configured branch above, this is
      // never something the person who just signed up should see fail.
      console.error("report-reddit-conversion: Reddit CAPI returned", redditRes.status, await redditRes.text());
    }

    return new Response(JSON.stringify({ ok: redditRes.ok }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("report-reddit-conversion: unexpected error", e);
    return new Response(JSON.stringify({ ok: false }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
