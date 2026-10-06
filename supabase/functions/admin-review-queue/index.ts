// Supabase Edge Function: admin-review-queue
//
// Backs the review/approval UI on the admin dashboard (src/AdminDashboard.jsx,
// served at /admin) — the one write path into trending_topics_cache.status
// beyond generate-trending-topics itself (which only ever writes 'pending').
// RLS on that table now only lets the anon key read status='approved' rows
// (see migration 0045), so this function — using the service role, which
// bypasses RLS — is also the only way to see what's sitting in the queue at
// all; there's no other way to read a pending row's content.
//
// Self-contained like every other function in this project (no shared
// imports across functions) — the auth block below is a copy of
// admin-usage-stats' own (itself a smaller copy of rabbit-hole-proxy-v2's),
// not a shared import.
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

// Same allowlist admin-usage-stats reads — one operator, one Supabase
// secret, not a DB is_admin column (see that function's own comment for
// the full reasoning). Deliberately the SAME env var, not a separate one:
// anyone who can see usage stats should also be able to review content,
// and there's only ever been one admin here.
const ADMIN_USER_IDS = new Set(
  (Deno.env.get("ADMIN_USER_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function unauthorized(corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const REVIEW_COLUMNS =
  "id, batch_date, field, topic, teaser, source_url, options, category, generated_at, input_tokens, output_tokens, model, cost_usd, status";

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

    const body = await req.json().catch(() => ({}));
    const action = typeof body?.action === "string" ? body.action : "list";

    if (action === "list") {
      // Pending (the actual queue) plus anything already rejected, so a
      // rejected pick doesn't just vanish with no record of the decision
      // — approved rows are left out, they're already live on the hero
      // page itself, nothing left to review there.
      const { data, error } = await supabase
        .from("trending_topics_cache")
        .select(REVIEW_COLUMNS)
        .in("status", ["pending", "rejected"])
        .order("generated_at", { ascending: false })
        .limit(100);
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ rows: data ?? [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "approve" || action === "reject") {
      const id = Number(body?.id);
      if (!Number.isFinite(id)) {
        return new Response(JSON.stringify({ error: "id is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const status = action === "approve" ? "approved" : "rejected";
      const { error } = await supabase.from("trending_topics_cache").update({ status }).eq("id", id);
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, id, status }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "approveAll") {
      // Convenience for a normal review pass — approve every currently-
      // pending row in one tap instead of clicking through each field.
      // Scoped to 'pending' specifically (not touching anything already
      // decided), so it's safe to hit even after some rows were already
      // individually approved/rejected.
      const { data, error } = await supabase
        .from("trending_topics_cache")
        .update({ status: "approved" })
        .eq("status", "pending")
        .select("id");
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, approved: data?.length ?? 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action "${action}"` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
