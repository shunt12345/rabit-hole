// Supabase Edge Function: track-event
//
// Lightweight, public, write-only endpoint for the Adoption analytics
// tables (migration 0049: visitors/sessions/events). Called from the
// client (src/lib/visitor.js + App.jsx) with no auth required — every
// anonymous visitor hits this, so there's no admin gate here, unlike
// admin-usage-stats/admin-review-queue. Fired with `keepalive: true` and
// never awaited by the UI (see App.jsx) — a dropped or slow call here
// should never be visible to a real visitor.
//
// Handles three things per call:
//   1. First-touch visitor upsert (insert ... on conflict do nothing —
//      only a BRAND NEW visitor_id's row actually gets first_source/
//      first_campaign/first_content written; a returning visitor's row is
//      left untouched no matter what UTMs are on this particular visit).
//   2. Session upsert, same on-conflict-do-nothing idea, scoped to this
//      session's own utm snapshot (see migration 0049's comment on why
//      this is separate from visitors.first_*).
//   3. The event row itself.
//
// Also opportunistically links visitor_id -> user_id whenever called with
// a signed-in user's access token — the SAME mechanism covers both a
// brand-new signup and a returning user on a new device, since there is
// no reliable server-side-only signal to tell those two apart (the
// client determines "is this a new signup" via lib/auth.js's
// isNewAccount() — the created_at/last_sign_in_at heuristic already
// trusted for Reddit's own conversion tracking — and fires the "signup"
// event itself; this function just links whatever user_id shows up).
// Also auto-flags is_test for the operator's own account here, since
// ADMIN_USER_IDS (an edge function secret) isn't readable from a DB
// trigger the way it is from this function.
//
// Self-contained like every other function in this project (no shared
// imports across functions).
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Same allowlist admin-usage-stats/admin-review-queue read — see either
// of those for the full reasoning (one operator, one Supabase secret, not
// a DB column). Used here only to auto-set is_test on the operator's own
// visitor_id once they're signed in, not as an access gate — this
// function has no gate, anyone can log an event.
const ADMIN_USER_IDS = new Set(
  (Deno.env.get("ADMIN_USER_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const EVENT_TYPES = new Set(["land", "tap", "article_view", "signup"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clip(s: unknown, max: number): string | null {
  return typeof s === "string" && s.trim() ? s.trim().slice(0, max) : null;
}

serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const visitorId = typeof body?.visitorId === "string" ? body.visitorId : "";
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const type = typeof body?.type === "string" ? body.type : "";
    const page = clip(body?.page, 200);
    const isTest = !!body?.isTest;

    if (!UUID_RE.test(visitorId) || !UUID_RE.test(sessionId) || !EVENT_TYPES.has(type)) {
      return new Response(JSON.stringify({ error: "invalid visitorId/sessionId/type" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const utmSource = clip(body?.utmSource, 60);
    const utmCampaign = clip(body?.utmCampaign, 120);
    const utmContent = clip(body?.utmContent, 120);
    const rdtCid = clip(body?.rdtCid, 120);

    // Resolve the signed-in user, if any — same pattern as every other
    // function here, but failure is never fatal: an expired/missing token
    // just means this call logs as anonymous, same as a real anonymous
    // visitor would.
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token) {
      const { data: userData } = await supabase.auth.getUser(token);
      userId = userData?.user?.id ?? null;
    }
    const linkIsTest = isTest || (userId !== null && ADMIN_USER_IDS.has(userId));

    // Only a brand-new visitor_id's row actually gets these fields — see
    // the file-level comment. Postgres unique-violation (code 23505,
    // "this visitor already exists") is the expected, common case here,
    // not a real error — only log anything else. is_test is handled
    // separately below (not part of this insert) since it needs to apply
    // even to an EXISTING visitor row once they sign in on the admin
    // account, which an on-conflict-do-nothing insert can't express.
    const { error: visitorError } = await supabase
      .from("visitors")
      .insert({ visitor_id: visitorId, first_source: utmSource, first_campaign: utmCampaign, first_content: utmContent });
    if (visitorError && visitorError.code !== "23505") {
      console.error("track-event: visitor insert failed", visitorError);
    }

    // Same idea for sessions — always attempt the insert rather than only
    // doing it for a "land" event: if an earlier call in this same
    // session (the one that should have created this row) was lost —
    // storage blocked, a dropped keepalive request — this event would
    // otherwise fail its FK constraint on session_id for no good reason.
    const { error: sessionError } = await supabase
      .from("sessions")
      .insert({ session_id: sessionId, visitor_id: visitorId, utm_source: utmSource, utm_campaign: utmCampaign, utm_content: utmContent, rdt_cid: rdtCid });
    if (sessionError && sessionError.code !== "23505") {
      console.error("track-event: session insert failed", sessionError);
    }

    if (userId || linkIsTest) {
      const update: Record<string, unknown> = {};
      if (userId) update.user_id = userId;
      if (linkIsTest) update.is_test = true;
      const { error: linkError } = await supabase.from("visitors").update(update).eq("visitor_id", visitorId);
      if (linkError) console.error("track-event: visitor link/is_test update failed", linkError);
    }

    const { error: eventError } = await supabase.from("events").insert({ visitor_id: visitorId, session_id: sessionId, type, page });
    if (eventError) {
      return new Response(JSON.stringify({ error: eventError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
