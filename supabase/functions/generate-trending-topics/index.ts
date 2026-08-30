// Supabase Edge Function: generate-trending-topics
//
// Two scheduled jobs (see the pg_cron migrations), NOT called by the app
// directly — the hero page's "In the news" + "Today" chips read the
// trending_topics_cache table this writes to, instead of hitting search
// live on every visit. One cron job runs the news fields (World News /
// Science / Technology) twice a day with a plain `{}` body; a second runs
// once nightly with `{"fields": ["National Day", "This Day In History"]}`
// — those two are date-anchored and only change once a day, so there's no
// reason to re-search them on the news cadence too. Uses Claude's
// web_search server tool with the same ANTHROPIC_API_KEY already used by
// rabbit-hole-proxy, so no new vendor is needed (unlike the dormant
// SerpApi-based trending-topics function this intentionally does not
// reuse).
//
// One Claude call per field, run concurrently, rather than a single call
// covering all of them — a combined call doing every field's search/lookup
// in one request risked the edge runtime's execution limit (seen in
// testing: WORKER_RESOURCE_LIMIT on a request that ran past ~60s).
// Per-field calls finish faster individually and fail independently — one
// field erroring doesn't take the others down with it.
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
//   5. Run the migrations that schedule the two cron jobs, if not already applied.

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NEWS_FIELDS = ["World News", "Science", "Technology"];
// Date-anchored, not news-search — same card treatment and cache table as
// the news fields, but built from a different prompt (see promptForField)
// since "recent development" doesn't apply to either of these.
const SPECIAL_FIELDS = ["National Day", "This Day In History"];
const FIELDS = [...NEWS_FIELDS, ...SPECIAL_FIELDS];
const MODEL = "claude-sonnet-5";
// How long a batch stays around before cleanup — just tidiness, not a
// correctness requirement (the app only ever reads the latest batch_date).
const RETENTION_DAYS = 14;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function fieldPrompt(field: string, excludeTopics: string[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const excludeBlock = excludeTopics.length
    ? `\n\nAlready shown recently — pick something genuinely different from all of these, not a rephrasing of any of them: ${excludeTopics.join("; ")}.`
    : "";
  return `Today's date is ${today}. You have live web search — use it now.

Search for a real, verifiable, and recent development in this field: ${field}. It doesn't have to be breaking news — anything genuinely current and fresh from roughly the last couple of weeks is fine — but it does need to be a specific real story, not something evergreen or generic. Use a specific, well-targeted query rather than a generic phrase like "news today" — generic queries tend to surface evergreen category pages instead of an actual dated story. If your first search doesn't turn up something specific, refine the query and search again.${excludeBlock}

Current, specific, and fresh — no historical background or context. The topic and teaser must be about a specific thing that happened or was announced recently, not general facts about the subject. For example, if the story involves a well-known company, don't lead with what the company is or its history — lead with the actual news (a specific earnings report, product launch, lawsuit, executive change, etc.). A reader should immediately understand what's NEW, not get a primer on the subject.

Once you've found a real story, produce:
- "topic": a short, punchy 2-5 word label suitable as a one-tap starting point for someone exploring the topic (title case, no trailing punctuation) — name the current event/development, not just the subject's name
- "teaser": one enticing sentence (max 20 words) describing the specific development, written to make someone curious to click it
- "source_url": the URL of the real source you found via search, supporting the story

Respond with ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{"topic": "...", "teaser": "...", "source_url": "..."}`;
}

function nationalDayPrompt(excludeTopics: string[]): string {
  const today = new Date();
  const monthDay = today.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const excludeBlock = excludeTopics.length
    ? `\n\nAlready shown recently — pick a different one this time, not a repeat of any of these: ${excludeTopics.join("; ")}.`
    : "";
  return `Today's date is ${today.toISOString().slice(0, 10)} (${monthDay}). You have live web search — use it now.

Search for a real, verifiable "National ___ Day" (or similar unofficial U.S. observance) that falls specifically on ${monthDay} — these repeat every year on the same month and day regardless of which year you find it listed under. If more than one observance falls on this date, pick whichever is genuinely more fun or interesting, not the most obscure option just to be different.${excludeBlock}

Once you've confirmed a real one via search, produce:
- "topic": the exact name of the day, e.g. "National Coffee Day" (title case, no trailing punctuation, no year)
- "teaser": one enticing sentence (max 20 words) that makes someone curious to click and learn about it
- "source_url": the URL of a real source confirming this observance falls on this date

Respond with ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{"topic": "...", "teaser": "...", "source_url": "..."}`;
}

function thisDayInHistoryPrompt(excludeTopics: string[]): string {
  const today = new Date();
  const monthDay = today.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const excludeBlock = excludeTopics.length
    ? `\n\nAlready shown recently — pick a genuinely different event from all of these, not a rephrasing of any of them: ${excludeTopics.join("; ")}.`
    : "";
  return `Today's date is ${today.toISOString().slice(0, 10)}. You have live web search — use it now.

Search for a real, verifiable, genuinely interesting event that happened specifically on ${monthDay} in history — any past year. Prefer something surprising or lesser-known over the single most obvious textbook event, but it must be historically accurate and confirmable via search, not misremembered trivia.${excludeBlock}

Once you've confirmed a real event via search, produce:
- "topic": a short punchy 2-6 word label naming the event (title case, no trailing punctuation, no year)
- "teaser": one enticing sentence (max 20 words) describing what happened — may include the year — written to make someone curious to click
- "source_url": the URL of a real source confirming this event and date

Respond with ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{"topic": "...", "teaser": "...", "source_url": "..."}`;
}

function promptForField(field: string, excludeTopics: string[]): string {
  if (field === "National Day") return nationalDayPrompt(excludeTopics);
  if (field === "This Day In History") return thisDayInHistoryPrompt(excludeTopics);
  return fieldPrompt(field, excludeTopics);
}

// Supabase Edge Functions (free tier) have a hard ~150s execution-time
// ceiling for the whole invocation. Fields run concurrently (see
// Promise.allSettled below), so wall time is roughly the slowest single
// field, not the sum — but cutting each one off well under the ceiling
// means a stuck field fails on its own instead of taking the whole run
// down with it.
const PER_FIELD_TIMEOUT_MS = 60_000;

async function generateForField(apiKey: string, field: string, excludeTopics: string[]) {
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
        messages: [{ role: "user", content: promptForField(field, excludeTopics) }],
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

// Recent topics per field, most-recent-first, so each run can be told what
// NOT to repeat — without this, an independent search per field tends to
// converge on the same single most-prominent story every time it runs.
async function fetchRecentTopicsByField(): Promise<Record<string, string[]>> {
  const { data, error } = await supabase
    .from("trending_topics_cache")
    .select("field, topic")
    .order("generated_at", { ascending: false })
    .limit(60);
  if (error || !data) {
    console.error("generate-trending-topics: failed to fetch recent topics for exclusion", error);
    return {};
  }
  const byField: Record<string, string[]> = {};
  for (const row of data) {
    const list = (byField[row.field] ??= []);
    if (list.length < 8 && !list.includes(row.topic)) list.push(row.topic);
  }
  return byField;
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

  // Which fields this invocation covers — lets one function serve two cron
  // schedules at different cadences instead of needing a second deploy.
  // NEWS_FIELDS churns fast enough to run twice a day (see the existing
  // cron job); SPECIAL_FIELDS is date-anchored and only changes once a
  // day, so it runs on its own once-nightly schedule that explicitly
  // requests {"fields": SPECIAL_FIELDS} in the request body. No body (or a
  // body with no valid "fields" array) falls back to NEWS_FIELDS, so the
  // existing cron job's plain `{}` body keeps working unchanged.
  const body = await req.json().catch(() => ({}));
  const requestedFields = Array.isArray(body?.fields)
    ? body.fields.filter((f: unknown) => typeof f === "string" && FIELDS.includes(f))
    : [];
  const fieldsToRun = requestedFields.length > 0 ? requestedFields : NEWS_FIELDS;

  const recentByField = await fetchRecentTopicsByField();
  const results = await Promise.allSettled(
    fieldsToRun.map((field) => generateForField(apiKey, field, recentByField[field] || []))
  );
  const rows: any[] = [];
  const errors: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      rows.push({ batch_date: today, ...r.value });
    } else {
      console.error(`generate-trending-topics: field "${fieldsToRun[i]}" failed`, r.reason);
      errors.push(`${fieldsToRun[i]}: ${r.reason}`);
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
