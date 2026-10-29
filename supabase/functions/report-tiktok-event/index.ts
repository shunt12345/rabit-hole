// Supabase Edge Function: report-tiktok-event
//
// Server-side half of TikTok Ads measurement (see src/lib/tiktokPixel.js
// for the browser pixel that fires the same events). Same reason as
// report-reddit-conversion: ad blockers, Safari's ITP and privacy browsers
// drop a real share of browser pixel fires, and TikTok's Events API is the
// server-to-server mirror that doesn't depend on the visitor's browser.
// The pixel and this function send the SAME event with the SAME event_id,
// and TikTok dedupes the pair rather than counting one action twice.
//
// Self-contained like every other function in this project (no shared
// imports across functions, so each one can be redeployed independently).
//
// Secrets (Supabase > Edge Functions > Secrets):
// - TIKTOK_ACCESS_TOKEN: Events Manager > the pixel > Settings > Events API
//   > Generate access token. Without it this function no-ops.
// - TIKTOK_TEST_EVENT_CODE: only while checking events in Events Manager's
//   Test events tab (e.g. TEST48771); remove it afterwards, since TikTok
//   treats every event carrying one as a test.
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const ALLOWED_ORIGINS = (
  Deno.env.get("ALLOWED_ORIGINS") ??
  "https://www.hyfax.app,https://hyfax.app,https://hyfa-x.vercel.app,http://localhost:5173,http://localhost:5183"
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

// Same extraction as rabbit-hole-proxy-v2's getClientIp.
function getClientIp(req: Request): string | null {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip");
}

// TikTok wants email SHA-256 hashed (lowercased and trimmed first).
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Only the events src/lib/tiktokPixel.js reports, all TikTok standard events.
const VALID_EVENTS = new Set(["ViewContent", "CompleteRegistration", "Subscribe"]);

// Not a secret: the same ID is in every page that loads the pixel.
const TIKTOK_PIXEL_ID = Deno.env.get("TIKTOK_PIXEL_ID") ?? "DBHLDJ3C77UASCMGRVU0";
const TIKTOK_ACCESS_TOKEN = Deno.env.get("TIKTOK_ACCESS_TOKEN");
const TIKTOK_TEST_EVENT_CODE = Deno.env.get("TIKTOK_TEST_EVENT_CODE");

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Not configured: fail open and quiet, since the client fires this
  // fire-and-forget and nothing a reader does should depend on ad tracking.
  if (!TIKTOK_ACCESS_TOKEN) return reply({ ok: false, reason: "not_configured" });

  try {
    const body = await req.json();
    const event = str(body?.event, 40);
    const eventId = str(body?.eventId, 100);
    if (!eventId || !VALID_EVENTS.has(event)) return reply({ error: "invalid event payload" }, 400);

    const user: Record<string, string> = {
      ip: getClientIp(req) ?? "",
      user_agent: req.headers.get("user-agent") ?? "",
    };
    const email = str(body?.email, 320).toLowerCase();
    if (email) user.email = await sha256Hex(email);
    // The ad click id (from the landing URL) and the pixel's own browser id
    // (its _ttp cookie): what lets TikTok tie this event to the ad click.
    const ttclid = str(body?.ttclid);
    if (ttclid) user.ttclid = ttclid;
    const ttp = str(body?.ttp);
    if (ttp) user.ttp = ttp;

    const properties: Record<string, string> = {};
    const contentName = str(body?.contentName, 100);
    if (contentName) {
      properties.content_type = "product";
      properties.content_name = contentName;
    }

    const tiktokRes = await fetch("https://business-api.tiktok.com/open_api/v1.3/event/track/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": TIKTOK_ACCESS_TOKEN },
      body: JSON.stringify({
        event_source: "web",
        event_source_id: TIKTOK_PIXEL_ID,
        ...(TIKTOK_TEST_EVENT_CODE ? { test_event_code: TIKTOK_TEST_EVENT_CODE } : {}),
        data: [
          {
            event,
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId,
            user,
            page: {
              url: str(body?.url, 1000) || req.headers.get("referer") || "https://www.hyfax.app/",
              ...(str(body?.referrer, 1000) ? { referrer: str(body?.referrer, 1000) } : {}),
            },
            ...(Object.keys(properties).length ? { properties } : {}),
          },
        ],
      }),
    });

    // TikTok answers 200 with its own code: 0 is success, anything else an
    // error with a message. Logged, never surfaced to the reader.
    const result = await tiktokRes.json().catch(() => null);
    const ok = tiktokRes.ok && result?.code === 0;
    if (!ok) console.error("report-tiktok-event: TikTok Events API returned", tiktokRes.status, JSON.stringify(result));
    return reply({ ok });
  } catch (e) {
    console.error("report-tiktok-event: unexpected error", e);
    return reply({ ok: false });
  }
});
