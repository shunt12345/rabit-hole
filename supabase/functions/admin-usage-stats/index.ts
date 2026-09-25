// Supabase Edge Function: admin-usage-stats
//
// Backs the in-app admin dashboard (src/AdminDashboard.jsx, served at
// /admin) — the ONLY way to read rabbit_hole_request_logs at all, since
// that table's RLS grants access to the service role exclusively (see
// migration 0001), on purpose: it holds every request's session id, IP,
// and cost, and none of that should ever be queryable straight from the
// browser with an anon key. This function is the narrow, read-only,
// admin-gated door into it.
//
// Self-contained like every other function in this project (no shared
// imports across functions) — resolveIdentity here is a smaller copy of
// rabbit-hole-proxy-v2's (just enough to verify who's calling, no
// funded/feature-toggle lookup needed for this purpose).
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

// A single hardcoded allowlist rather than an "is_admin" column on
// profiles — this app has exactly one operator, and a Supabase secret
// (never in client code, never in git) is the simplest thing that's
// actually secure for that. Comma-separated Supabase auth user ids (the
// uuid in auth.users.id, findable via Authentication > Users in the
// dashboard) — NOT emails, since a user id can't be spoofed by signing up
// with a look-alike address the way an email check could be.
const ADMIN_USER_IDS = new Set(
  (Deno.env.get("ADMIN_USER_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// Same ceiling rabbit-hole-proxy-v2 enforces — read here too purely so the
// dashboard can show "$X spent / $Y cap today" using whatever the real
// configured limit is, without hardcoding a number that could drift out of
// sync with the actual enforced value.
const GLOBAL_DAILY_SPEND_LIMIT_USD = Number(Deno.env.get("GLOBAL_DAILY_SPEND_LIMIT_USD") ?? "50");

function unauthorized(corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return unauthorized(corsHeaders);

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return unauthorized(corsHeaders);

    if (ADMIN_USER_IDS.size === 0 || !ADMIN_USER_IDS.has(userData.user.id)) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = Date.now();
    const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    // One fetch covering the widest window (30 days) — everything else
    // below is derived from this same row set in-process rather than
    // issuing a separate query per metric. Fine at this app's current
    // scale; worth revisiting with a real SQL aggregate (or a dedicated
    // RPC, like get_recent_spend_usd) if this table ever gets big enough
    // for a 30-day pull to be slow.
    const [{ data: rows, error: rowsErr }, { data: spend24h, error: spendErr }, { data: usersPage, error: usersErr }] =
      await Promise.all([
        supabase
          .from("rabbit_hole_request_logs")
          .select("created_at, session_id, endpoint, cost_usd, latency_ms, user_id, ip_address, funded")
          .gte("created_at", since30d)
          .order("created_at", { ascending: false })
          .limit(50000),
        supabase.rpc("get_recent_spend_usd", { since: since24h }),
        supabase.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      ]);

    if (rowsErr) throw rowsErr;
    if (spendErr) throw spendErr;
    if (usersErr) throw usersErr;

    const allRows = rows ?? [];

    // Daily requests/sessions/spend, full 30-day window.
    const dailyMap = new Map<string, { requests: number; sessions: Set<string>; spendUsd: number }>();
    for (const r of allRows) {
      const day = String(r.created_at).slice(0, 10);
      const bucket = dailyMap.get(day) ?? { requests: 0, sessions: new Set<string>(), spendUsd: 0 };
      bucket.requests += 1;
      if (r.session_id) bucket.sessions.add(r.session_id);
      bucket.spendUsd += Number(r.cost_usd ?? 0);
      dailyMap.set(day, bucket);
    }
    const daily = [...dailyMap.entries()]
      .map(([day, b]) => ({ day, requests: b.requests, uniqueSessions: b.sessions.size, spendUsd: b.spendUsd }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));

    // Endpoint breakdown, last 7 days.
    const recentRows = allRows.filter((r) => String(r.created_at) >= since7d);
    const endpointMap = new Map<string, { requests: number; spendUsd: number; latencySum: number; latencyCount: number }>();
    for (const r of recentRows) {
      const bucket = endpointMap.get(r.endpoint) ?? { requests: 0, spendUsd: 0, latencySum: 0, latencyCount: 0 };
      bucket.requests += 1;
      bucket.spendUsd += Number(r.cost_usd ?? 0);
      if (r.latency_ms != null) {
        bucket.latencySum += Number(r.latency_ms);
        bucket.latencyCount += 1;
      }
      endpointMap.set(r.endpoint, bucket);
    }
    const byEndpoint = [...endpointMap.entries()]
      .map(([endpoint, b]) => ({
        endpoint,
        requests: b.requests,
        spendUsd: b.spendUsd,
        avgLatencyMs: b.latencyCount ? Math.round(b.latencySum / b.latencyCount) : null,
      }))
      .sort((a, b) => b.spendUsd - a.spendUsd);

    // Signed-in vs anonymous split, last 7 days.
    let signedInRequests = 0;
    let signedInSpend = 0;
    let anonRequests = 0;
    let anonSpend = 0;
    for (const r of recentRows) {
      if (r.user_id) {
        signedInRequests += 1;
        signedInSpend += Number(r.cost_usd ?? 0);
      } else {
        anonRequests += 1;
        anonSpend += Number(r.cost_usd ?? 0);
      }
    }
    const identitySplit = [
      { signedIn: true, requests: signedInRequests, spendUsd: signedInSpend },
      { signedIn: false, requests: anonRequests, spendUsd: anonSpend },
    ];

    // Funded vs. free-tier spend, last 7 days — `funded` is captured at
    // request time (migration 0032), not derived from the account's
    // CURRENT balance, so this reflects what was actually true when the
    // money was spent. Rows logged before that column existed have
    // funded === null, kept as its own "unknown (pre-tracking)" bucket
    // rather than silently folded into either real bucket.
    let fundedRequests = 0;
    let fundedSpend = 0;
    let freeRequests = 0;
    let freeSpend = 0;
    let unknownRequests = 0;
    let unknownSpend = 0;
    for (const r of recentRows) {
      const cost = Number(r.cost_usd ?? 0);
      if (r.funded === true) {
        fundedRequests += 1;
        fundedSpend += cost;
      } else if (r.funded === false) {
        freeRequests += 1;
        freeSpend += cost;
      } else {
        unknownRequests += 1;
        unknownSpend += cost;
      }
    }
    const fundedSplit = [
      { tier: "Funded", requests: fundedRequests, spendUsd: fundedSpend },
      { tier: "Free", requests: freeRequests, spendUsd: freeSpend },
      ...(unknownRequests ? [{ tier: "Unknown (pre-tracking)", requests: unknownRequests, spendUsd: unknownSpend }] : []),
    ];

    // Top IPs, last 24h — abuse/scraping visibility.
    const ipRows = allRows.filter((r) => String(r.created_at) >= since24h && r.ip_address);
    const ipMap = new Map<string, number>();
    for (const r of ipRows) ipMap.set(r.ip_address!, (ipMap.get(r.ip_address!) ?? 0) + 1);
    const topIps = [...ipMap.entries()]
      .map(([ip, requests]) => ({ ip, requests }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 20);

    // New accounts per day, last 30 days — auth.users isn't queryable via
    // the regular postgrest client, hence the admin.listUsers() call above
    // instead of a .from("...") select.
    const signupMap = new Map<string, number>();
    for (const u of usersPage?.users ?? []) {
      if (!u.created_at || u.created_at < since30d) continue;
      const day = u.created_at.slice(0, 10);
      signupMap.set(day, (signupMap.get(day) ?? 0) + 1);
    }
    const dailySignups = [...signupMap.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));

    return new Response(
      JSON.stringify({
        spendLast24hUsd: Number(spend24h ?? 0),
        spendCapUsd: GLOBAL_DAILY_SPEND_LIMIT_USD,
        daily,
        byEndpoint,
        identitySplit,
        fundedSplit,
        topIps,
        dailySignups,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("admin-usage-stats: unexpected error", e);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
