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
// A reject deletes the row and immediately calls generate-trending-topics
// again for that same field (see regenerateField below), so a replacement
// shows up to review right away instead of that field sitting empty until
// the next scheduled run.
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
  "id, batch_date, field, topic, teaser, source_url, options, category, direction, generated_at, input_tokens, output_tokens, model, cost_usd, status, publish_at, riddle_game";

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

// The next morning's hero slot: the next 07:00 UTC, when the 07:00 sweep
// (migration 0055's publish_due_trending_topics) runs. Approving a pick
// schedules it for this slot (publish_at), so it never goes live the same
// day it's reviewed, whichever version of generate-trending-topics wrote it.
function nextSlot(now: Date = new Date()): string {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7));
  if (at.getTime() <= now.getTime()) at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString();
}

// The slot's approved picks, one per field at most (approving replaces).
async function slotApproved(slot: string) {
  return await supabase.from("trending_topics_cache").select(REVIEW_COLUMNS).eq("status", "approved").eq("publish_at", slot);
}

// Once every hero card has an approved pick for the slot, whatever's left
// over is done with: unchosen alternatives still pending for the slot and
// any rejected rows. Returns how many rows were deleted, or null if the
// slot isn't complete yet.
async function finalizeIfComplete(slot: string): Promise<number | null> {
  const { data: approved } = await slotApproved(slot);
  const fieldsDone = new Set((approved ?? []).map((r: { field: string }) => r.field));
  if (!SUGGESTIBLE_FIELDS.every((f) => fieldsDone.has(f))) return null;
  const { data: leftovers } = await supabase
    .from("trending_topics_cache")
    .delete()
    .or(`status.eq.rejected,and(status.eq.pending,or(publish_at.is.null,publish_at.lte.${slot}))`)
    .select("id");
  return leftovers?.length ?? 0;
}

// Approves one pick into the slot, replacing any pick already approved for
// that field there, so tomorrow's hero shows exactly the one chosen.
async function approveIntoSlot(id: number, field: string, slot: string) {
  const { error } = await supabase.from("trending_topics_cache").update({ status: "approved", publish_at: slot }).eq("id", id);
  if (error) return error;
  await supabase.from("trending_topics_cache").delete().eq("status", "approved").eq("field", field).eq("publish_at", slot).neq("id", id);
  return null;
}

// The riddle game's curated pieces (migration 0056), as saved from /queue.
// Shape-checked rather than trusted, since it's written straight to a row
// the hero page reads.
type RiddleClue = { title: string; field: string; teaser: string };
type RiddleGame = { clues: RiddleClue[]; hints: string[]; answers: string[] };
const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
function cleanClue(c: any): RiddleClue {
  return { title: str(c?.title, 80), field: str(c?.field, 30).toLowerCase(), teaser: str(c?.teaser, 200) };
}
function cleanRiddleGame(raw: any): RiddleGame | null {
  const clues = Array.isArray(raw?.clues) ? raw.clues.map(cleanClue) : [];
  const hints = Array.isArray(raw?.hints) ? raw.hints.map((h: unknown) => str(h, 60)).filter(Boolean) : [];
  const answers = Array.isArray(raw?.answers) ? raw.answers.map((a: unknown) => str(a, 60).toLowerCase()).filter(Boolean) : [];
  if (clues.length !== 4 || clues.some((c: RiddleClue) => !c.title) || hints.length !== 3 || !answers.length) return null;
  return { clues, hints, answers };
}

// On approving a riddle with game pieces: the answer's topic page gets its
// four clues as its "Where to next?" thread cards, so a player who solves
// it lands on threads matching what they just worked through. Keyed the
// way the hero page opens the answer (news_root_cache by topic). Pinned so
// the article naming one doesn't drop it (see expandNode in App.jsx). A
// page already cached for the topic (a past riddle, or a preview) keeps
// its article but gets these threads in place of its own. The hero page
// also opens the answer with the clues directly; this covers the cache.
async function precacheRiddleAnswer(topic: string, game: RiddleGame) {
  const children = game.clues.map((c, i) => ({ label: c.title, teaser: c.teaser, type: i < 2 ? "indirect" : "tangent", pinned: true }));
  const { data: existing } = await supabase.from("news_root_cache").select("cache_key").eq("cache_key", topic).maybeSingle();
  const { error } = existing
    ? await supabase.from("news_root_cache").update({ children }).eq("cache_key", topic)
    : await supabase.from("news_root_cache").insert({ cache_key: topic, root_label: topic, overview: "", children });
  if (error) console.error("admin-review-queue: failed to pre-cache riddle answer", error);
}

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
// The just-rejected row is still in the table (status='rejected') while
// this runs, so fetchRecentTopicsByField's exclude-history query — which
// has no status filter — picks it up and steers the new attempt away from
// repeating it. The reject action deletes it once this returns.
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
      // The queue (every pending pick) plus the next slot's approved picks,
      // which the page shows as tomorrow's hero checklist.
      const slot = nextSlot();
      const [pending, approved] = await Promise.all([
        supabase
          .from("trending_topics_cache")
          .select(REVIEW_COLUMNS)
          .eq("status", "pending")
          .order("generated_at", { ascending: false })
          .limit(100),
        slotApproved(slot),
      ]);
      const error = pending.error || approved.error;
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ rows: pending.data ?? [], slot, approved: approved.data ?? [], fields: SUGGESTIBLE_FIELDS }), {
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
      // Need the row's field BEFORE updating it — fetched here rather
      // than trusting a `field` the client might send, same reasoning as
      // never trusting client-supplied data for a write.
      const { data: existing, error: fetchErr } = await supabase
        .from("trending_topics_cache")
        .select("field, topic, riddle_game")
        .eq("id", id)
        .maybeSingle();
      if (fetchErr || !existing) {
        return new Response(JSON.stringify({ error: fetchErr?.message || `No row with id ${id}` }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const slot = nextSlot();
      if (action === "approve") {
        const error = await approveIntoSlot(id, existing.field, slot);
        if (!error && existing.riddle_game) {
          const game = cleanRiddleGame(existing.riddle_game);
          if (game) await precacheRiddleAnswer(existing.topic, game);
        }
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const cleaned = await finalizeIfComplete(slot);
        return new Response(JSON.stringify({ ok: true, id, status: "approved", complete: cleaned !== null, cleaned }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { error } = await supabase.from("trending_topics_cache").update({ status: "rejected" }).eq("id", id);
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const regenerated = await regenerateField(existing.field);
      // A rejected pick is deleted, not kept — but only after its
      // replacement is generated, since that run reads the field's past
      // picks (rejected ones included) to avoid offering it again.
      const { error: deleteErr } = await supabase.from("trending_topics_cache").delete().eq("id", id);
      if (deleteErr) console.error("admin-review-queue: failed to delete rejected row", deleteErr);
      return new Response(JSON.stringify({ ok: true, id, status: "rejected", regenerated }), {
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

    if (action === "getRow") {
      // One pick in any status — the hero page's riddle preview
      // (?riddlePreview=<id>) plays a pending riddle before it's approved.
      const { data, error } = await supabase.from("trending_topics_cache").select(REVIEW_COLUMNS).eq("id", Number(body?.id)).maybeSingle();
      if (error || !data) {
        return new Response(JSON.stringify({ error: error?.message || "No such pick" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ row: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "saveRiddleGame" || action === "regenerateClue") {
      const id = Number(body?.id);
      const { data: row } = await supabase.from("trending_topics_cache").select("topic, field, riddle_game").eq("id", id).maybeSingle();
      if (!row || row.field !== "Riddle") {
        return new Response(JSON.stringify({ error: "Not a riddle row" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      let game = cleanRiddleGame(action === "saveRiddleGame" ? body?.riddle_game : row.riddle_game);
      if (!game) {
        return new Response(JSON.stringify({ error: "A riddle needs 4 clues, 3 hints and at least one accepted answer." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (action === "regenerateClue") {
        // ↻ on one clue: generate-trending-topics writes a replacement from
        // a field the other three don't use.
        const index = Number(body?.index);
        if (!Number.isInteger(index) || index < 0 || index > 3 || !CRON_SECRET) {
          return new Response(JSON.stringify({ error: "Bad clue index" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-trending-topics`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cron-secret": CRON_SECRET },
          body: JSON.stringify({ riddleClue: { answer: row.topic, clues: game.clues, index } }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.clue?.title) {
          return new Response(JSON.stringify({ error: data?.error || `Clue generation failed (${res.status})` }), {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const fresh = cleanClue(data.clue);
        game = { ...game, clues: game.clues.map((c, i) => (i === index ? fresh : c)) };
      }
      const { error } = await supabase.from("trending_topics_cache").update({ riddle_game: game }).eq("id", id);
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, riddle_game: game }), {
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
      // Approves the newest pending pick for each field that doesn't have
      // an approved pick for the slot yet, then cleans up if that
      // completes the slot. Fields already approved are left alone.
      const slot = nextSlot();
      const [{ data: pending, error }, { data: approved }] = await Promise.all([
        supabase.from("trending_topics_cache").select("id, field").eq("status", "pending").order("generated_at", { ascending: false }),
        slotApproved(slot),
      ]);
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const done = new Set((approved ?? []).map((r: { field: string }) => r.field));
      let count = 0;
      for (const row of pending ?? []) {
        if (done.has(row.field)) continue;
        done.add(row.field);
        if (!(await approveIntoSlot(row.id, row.field, slot))) count++;
      }
      const cleaned = await finalizeIfComplete(slot);
      return new Response(JSON.stringify({ ok: true, approved: count, complete: cleaned !== null, cleaned }), {
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
