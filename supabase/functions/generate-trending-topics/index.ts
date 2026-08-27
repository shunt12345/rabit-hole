// Supabase Edge Function: generate-trending-topics
//
// A scheduled job (see the pg_cron migration), NOT called by the app
// directly — the hero page's "In the news" chips read the
// trending_topics_cache table this writes to, instead of hitting search
// live on every visit. Uses Claude's web_search server tool with the same
// ANTHROPIC_API_KEY already used by rabbit-hole-proxy, so no new vendor is
// needed (unlike the dormant SerpApi-based trending-topics function this
// intentionally does not reuse).
//
// One Claude call per field, run concurrently, rather than a single call
// covering all 4 — a combined call doing 4 searches' worth of work in one
// request risked the edge runtime's execution limit (seen in testing:
// WORKER_RESOURCE_LIMIT on a request that ran past ~60s). Per-field calls
// finish faster individually and fail independently — one field erroring
// doesn't take the other three down with it.
//
// Protected by a shared secret (checked against the CRON_SECRET function
// secret), not the public anon key — each run costs real search +
// generation calls and should only ever fire on the schedule, not from a
// visitor's browser.
//
// DEPLOY STEPS:
//   1. Pick a random secret string.
//   2. supabase secrets set CRON_SECRET=<that secret>
//   3. supabase db query --linked "select vault.create_secret('<that secret>', 'cron_secret');"
//      (the pg_cron job reads it back from Vault by that name — see the
//      migration — so the raw value never needs to live in a committed file)
//   4. supabase functions deploy generate-trending-topics --no-verify-jwt
//      (this function is cron-only, not reachable with a Supabase JWT —
//      see config.toml)
//   5. Run the migration that schedules the cron job, if not already applied.

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FIELDS = ["World News", "Science", "Technology", "Culture & Arts"];
const MODEL = "claude-sonnet-5";
// How long a batch stays around before cleanup — just tidiness, not a
// correctness requirement (the app only ever reads the latest batch_date).
const RETENTION_DAYS = 14;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function fieldPrompt(field: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `Today's date is ${today}. You have live web search — use it now.

Search for a genuinely current, real, verifiable news story from the last few days in this field: ${field}. Use a specific, well-targeted query rather than a generic phrase like "news today" — generic queries tend to surface evergreen category pages instead of an actual dated story. If your first search doesn't turn up something specific and recent, refine the query and search again.

Once you've found a real story, produce:
- "topic": a short, punchy 2-5 word label suitable as a one-tap starting point for someone exploring the topic (title case, no trailing punctuation)
- "teaser": one enticing sentence (max 20 words) that would make someone curious to click it
- "source_url": the URL of the real source you found via search, supporting the story

Respond with ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{"topic": "...", "teaser": "...", "source_url": "..."}`;
}

// Supabase Edge Functions (free tier) have a hard ~150s execution-time
// ceiling for the whole invocation. Fields run concurrently (see
// Promise.allSettled below), so wall time is roughly the slowest single
// field, not the sum — but cutting each one off well under the ceiling
// means a stuck field fails on its own instead of taking the whole run
// down with it.
const PER_FIELD_TIMEOUT_MS = 60_000;

async function generateForField(apiKey: string, field: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PER_FIELD_TIMEOUT_MS);
  let anthropicRes: Response;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        thinking: { type: "disabled" },
        // The basic variant (not the code-execution-backed dynamic-filtering
        // one) — testing found the dynamic-filtering variant has the model
        // write its own Python glue around web_search, and buggy generated
        // code triggered retry loops that blew well past this function's
        // execution budget. The basic variant returns results directly with
        // no code-execution round trip, and one field took ~5s in testing.
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
        messages: [{ role: "user", content: fieldPrompt(field) }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!anthropicRes.ok) {
    throw new Error(`Anthropic returned ${anthropicRes.status}: ${(await anthropicRes.text()).slice(0, 300)}`);
  }

  const data = await anthropicRes.json();
  const text = (data.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");

  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON in response: ${text.slice(0, 300)}`);
  }

  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  const topic = (parsed.topic || "").trim();
  const teaser = (parsed.teaser || "").trim();
  if (!topic || !teaser) {
    throw new Error(`Missing topic/teaser: ${cleaned.slice(0, 300)}`);
  }
  return { field, topic, teaser, source_url: parsed.source_url || null };
}

serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY secret is not set on this function" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const results = await Promise.allSettled(FIELDS.map((field) => generateForField(apiKey, field)));
  const rows: any[] = [];
  const errors: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      rows.push({ batch_date: today, ...r.value });
    } else {
      console.error(`generate-trending-topics: field "${FIELDS[i]}" failed`, r.reason);
      errors.push(`${FIELDS[i]}: ${r.reason}`);
    }
  });

  if (rows.length === 0) {
    return new Response(JSON.stringify({ error: "All fields failed", details: errors }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { error: insertError } = await supabase.from("trending_topics_cache").insert(rows);
  if (insertError) {
    return new Response(JSON.stringify({ error: `DB insert failed: ${insertError.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Best-effort cleanup — never worth failing the run over.
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await supabase.from("trending_topics_cache").delete().lt("batch_date", cutoff);
  } catch (e) {
    console.error("generate-trending-topics: cleanup failed", e);
  }

  return new Response(JSON.stringify({ inserted: rows.length, batch_date: today, errors }), {
    headers: { "Content-Type": "application/json" },
  });
});
