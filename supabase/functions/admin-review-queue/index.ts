// Supabase Edge Function: admin-review-queue
//
// Backs the review/approval UI (src/ReviewQueue.jsx, served at /queue) —
// the one write path into trending_topics_cache.status beyond generate-
// trending-topics itself (which only ever writes 'pending'). RLS on that
// table only lets the anon key read status='approved' rows (see migration
// 0045), so this function — using the service role, which bypasses RLS —
// is also the only way to see what's sitting in the queue at all; there's
// no other way to read a pending row's content.
//
// A reject doesn't just mark the row — it immediately calls generate-
// trending-topics again for that same field (see regenerateField below),
// so a replacement shows up to review right away instead of that field
// sitting empty until the next scheduled run.
//
// "suggest" (below) is the same mechanism run on demand instead of after a
// reject — the operator picks a field slot and types a raw idea, and this
// calls generate-trending-topics for that field with that idea as a seed,
// landing a new 'pending' row to review just like any other pick.
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
  "id, batch_date, field, topic, teaser, source_url, options, category, direction, generated_at, input_tokens, output_tokens, model, cost_usd, status, publish_at";

// The fields a suggestion can target — every named field generate-
// trending-topics knows how to seed (see its own promptForField/seedIdea
// threading), mirrored here as a literal list rather than imported (no
// shared imports across functions in this project). Excludes nothing from
// generate-trending-topics' own FIELDS except the generic fallback path
// (fieldPrompt), which isn't exercised by any real field name today.
const SUGGESTIBLE_FIELDS = [
  "Trending 1",
  "Trending 2",
  "This Day In History",
  "Word Of The Day",
  "Quote Of The Day",
  "Riddle",
  "Perspective",
];

// Same shared project secrets generate-trending-topics itself reads (every
// function in this project draws from one pool, not per-function secrets
// — see that function's DEPLOY STEPS comment) — lets this function call it
// server-to-server the exact same way its own cron jobs do.
const CRON_SECRET = Deno.env.get("CRON_SECRET");
// Comfortably under generate-trending-topics' own ~150s platform ceiling
// (see that function's PER_FIELD_TIMEOUT_MS comment) — this is a single
// field, which should finish well inside that, but a hard cap here means
// a stuck regeneration fails the reject's response cleanly instead of
// this function itself running out the clock.
const REGENERATE_TIMEOUT_MS = 120_000;

// Fires immediately after a reject — rather than leaving that field with
// nothing pending until the next scheduled run (or the 07:00 UTC auto-
// approve sweep, which has nothing to approve for it either), this kicks
// off a fresh generateForField call for the SAME field right away, so a
// new option shows up in the queue to review in its place. Reuses the
// exact same request shape generate-trending-topics' own cron jobs use.
// The just-rejected row is left in the table (status='rejected', not
// deleted) specifically so fetchRecentTopicsByField's exclude-history
// query — which has no status filter — picks it up and steers the new
// attempt away from repeating it.
//
// Also the engine behind the "suggest" action below — generate-trending-
// topics' own `suggestion` body field (threaded into its per-field prompt
// builders as seedIdea) is what turns the SAME one-field call into "write
// about this specific idea" instead of its normal open search/choice;
// `suggestion` just rides along as an optional extra here.
// "Generate new batch" on /queue — the same two requests the 15:00 UTC
// cron jobs make (migrations 0046/0047: the news fields, then everything
// else), for when a batch needs replacing outside that schedule. A full
// run takes a couple of minutes, longer than this request should wait, so
// both run in the background and the new rows simply appear in the queue
// once they land. Like a scheduled batch, they go public at the next
// 07:00 UTC (publish_at, migration 0053), not when approved.
const BATCH_REQUESTS = [{}, { fields: ["This Day In History", "Word Of The Day", "Quote Of The Day", "Riddle", "Perspective"] }];
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

function startBatchGeneration() {
  const runs = Promise.allSettled(
    BATCH_REQUESTS.map((body) =>
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-trending-topics`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": CRON_SECRET! },
        body: JSON.stringify(body),
      }).then(async (res) => {
        if (!res.ok) console.error("admin-review-queue: batch generation failed", res.status, (await res.text()).slice(0, 300));
      })
    )
  );
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(runs);
}

async function regenerateField(field: string, suggestion?: string): Promise<{ ok: boolean; error?: string }> {
  if (!CRON_SECRET) return { ok: false, error: "CRON_SECRET is not set on this function" };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REGENERATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-trending-topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": CRON_SECRET,
      },
      body: JSON.stringify({ fields: [field], ...(suggestion ? { suggestion } : {}) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `generate-trending-topics returned ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const data = await res.json();
    if (!data.inserted) {
      return { ok: false, error: Array.isArray(data.errors) && data.errors.length ? data.errors[0] : "No row generated" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeoutId);
  }
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

    const body = await req.json().catch(() => ({}));
    const action = typeof body?.action === "string" ? body.action : "list";

    if (action === "list") {
      // Pending (the actual queue, no cutoff — a stale pending row is
      // exactly what the 07:00 UTC auto-approve sweep is for, not
      // something to hide here) plus RECENTLY rejected rows, so a reject
      // doesn't just vanish from view with no confirmation it went
      // through — but confirmed live this needs a real cutoff: with none,
      // every reject ever made (including ones from testing) piles up in
      // this list forever. Rejected rows are never deleted from the table
      // itself (fetchRecentTopicsByField's exclude-history has no status
      // filter and still needs them), this just stops the UI from
      // showing ones from more than a day ago. Approved rows are left out
      // entirely either way — they're already live on the hero page,
      // nothing left to review there.
      const rejectedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("trending_topics_cache")
        .select(REVIEW_COLUMNS)
        .or(`status.eq.pending,and(status.eq.rejected,generated_at.gte.${rejectedCutoff})`)
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
      // Need the row's field BEFORE updating it — fetched here rather
      // than trusting a `field` the client might send, same reasoning as
      // never trusting client-supplied data for a write.
      const { data: existing, error: fetchErr } = await supabase
        .from("trending_topics_cache")
        .select("field")
        .eq("id", id)
        .maybeSingle();
      if (fetchErr || !existing) {
        return new Response(JSON.stringify({ error: fetchErr?.message || `No row with id ${id}` }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { error } = await supabase.from("trending_topics_cache").update({ status }).eq("id", id);
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      let regenerated: { ok: boolean; error?: string } | undefined;
      if (action === "reject") {
        regenerated = await regenerateField(existing.field);
      }
      return new Response(JSON.stringify({ ok: true, id, status, ...(regenerated ? { regenerated } : {}) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "suggest") {
      // The "suggest a topic" agent (/queue) — writes a NEW pending row for
      // an existing field slot, seeded from a raw idea the operator typed
      // in, via the same generateForField call every other row in this
      // table goes through (same review-before-publish posture, same
      // duplicate-prevention against that field's exclude history). This
      // is the one action in this function that creates a row rather than
      // transitioning an existing one.
      const field = typeof body?.field === "string" ? body.field : "";
      const suggestion = typeof body?.suggestion === "string" ? body.suggestion.trim() : "";
      if (!SUGGESTIBLE_FIELDS.includes(field)) {
        return new Response(JSON.stringify({ error: `Unknown field "${field}"` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!suggestion) {
        return new Response(JSON.stringify({ error: "suggestion is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (suggestion.length > 300) {
        return new Response(JSON.stringify({ error: "suggestion is too long (300 characters max)" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = await regenerateField(field, suggestion);
      if (!result.ok) {
        return new Response(JSON.stringify({ error: result.error || "Failed to generate suggestion" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "generateBatch") {
      if (!CRON_SECRET) {
        return new Response(JSON.stringify({ error: "CRON_SECRET is not set on this function" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      startBatchGeneration();
      return new Response(JSON.stringify({ ok: true, started: true }), {
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
