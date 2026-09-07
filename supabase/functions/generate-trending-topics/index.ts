// Supabase Edge Function: generate-trending-topics
//
// Two scheduled jobs (see the pg_cron migrations), NOT called by the app
// directly — the hero page's "Trending" + "Today" chips read the
// trending_topics_cache table this writes to, instead of hitting search
// live on every visit. One cron job runs the trending fields (two
// mainstream picks + one offbeat wildcard — see TRENDING_MAINSTREAM_FIELDS/
// TRENDING_WILDCARD_FIELD below; this replaced the original fixed World
// News/Science/Technology beats) twice a day with a plain `{}` body; a
// second runs once nightly with `{"fields": ["National Day", "This Day In
// History", "Word Of The Day"]}` — those three only change once a day (or,
// for Word Of The Day, aren't tied to the date at all), so there's no
// reason to re-run them on the trending cadence too. Uses Claude's
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

// Three picks per run, not three separate topical beats — two aimed at
// whatever's genuinely trending/most-talked-about right now (mainstream),
// one deliberately reaching for something more offbeat/under-the-radar
// that's still real and actually trending today (see trendingWildcardPrompt
// below). Kept as three distinct field keys (rather than one field with
// three rows) because latestByField on the client picks exactly one row
// per field name — three names is what gets three chips on screen.
const TRENDING_MAINSTREAM_FIELDS = ["Trending 1", "Trending 2"];
const TRENDING_WILDCARD_FIELD = "Trending Wildcard";
const NEWS_FIELDS = [...TRENDING_MAINSTREAM_FIELDS, TRENDING_WILDCARD_FIELD];
// Date-anchored, not news-search — same card treatment and cache table as
// the news fields, but built from a different prompt (see promptForField)
// since "recent development" doesn't apply to any of these. "Word Of The
// Day" isn't actually tied to today's specific date the way the other two
// are (a word doesn't have a calendar date) — it's here because it shares
// their real mechanic: one nightly pick, no live-search "recent story"
// framing, excludeTopics keeps it from repeating.
const SPECIAL_FIELDS = ["National Day", "This Day In History", "Word Of The Day"];
const FIELDS = [...NEWS_FIELDS, ...SPECIAL_FIELDS];
// Overridable via `supabase secrets set MODEL=...` without a redeploy —
// same reasoning as rabbit-hole-proxy's MODEL constant: lets a candidate
// model get tried via a secret update instead of a code change, but
// still wants a real side-by-side quality check before actually
// switching for good, not an auto-upgrade to "whatever's newest."
const MODEL = Deno.env.get("MODEL") ?? "claude-sonnet-5";

// Restricts web_search to a curated set of reputable, dedicated-article
// outlets — ONLY for the two mainstream trending fields. Confirmed live
// (repeatedly, across several rounds of prompt-only tightening) that
// mainstream stories kept citing generic section fronts, liveblogs, and
// roundup/digest posts even after multiple rewrites of the source_url
// instructions — see SOURCE_URL_CHECK below. A domain allowlist fixes this
// structurally instead of relying on the model to keep judging "specific
// enough" correctly. Deliberately NOT applied to the wildcard field or the
// special date-anchored fields: an offbeat/under-the-radar story often
// hasn't been picked up by a major outlet yet (that's the point of it),
// and "This Day In History" was tuned to prefer local/regional sources —
// a local paper or historical society site would never be on this list.
// Bare domains with an optional path, no scheme (per Anthropic's
// web_search allowed_domains format) — max 64 entries, well under that here.
//
// Confirmed live: several major outlets are NOT usable here even though
// they're reputable — Anthropic validates every allowed_domains entry up
// front and 400s the WHOLE request if any of them block/restrict its
// search user agent, rather than just skipping that one domain. apnews.com,
// reuters.com, bbc.com, nytimes.com, theguardian.com, wsj.com, politico.com,
// theverge.com, and arstechnica.com all got rejected this way — pulled from
// the list below. Don't add a domain back without firing this function
// again to confirm it actually passes.
const TRUSTED_MAINSTREAM_DOMAINS = [
  "npr.org",
  "axios.com",
  "washingtonpost.com",
  "cnn.com",
  "nbcnews.com",
  "abcnews.go.com",
  "cbsnews.com",
  "thehill.com",
  "bloomberg.com",
  "techcrunch.com",
  "espn.com",
  "variety.com",
  "billboard.com",
];

// Overridable via `supabase secrets set` without a redeploy, same pattern as
// DAILY_REQUEST_LIMIT in rabbit-hole-proxy — so a future Anthropic price
// change is a config update, not a code change, and doesn't silently
// mis-cost rows logged before the change (each row keeps the rate that was
// actually in effect when it was computed, since cost_usd is computed once
// at insert time, not derived later from a rate that could have moved on).
// Named for Sonnet specifically (this app's current model) — if MODEL
// above ever gets switched to a different model family, update these two
// alongside it, or every cost computed here keeps using the old rate.
const INPUT_PRICE_PER_M = Number(Deno.env.get("SONNET_INPUT_PRICE_PER_M") ?? "2.00");
const OUTPUT_PRICE_PER_M = Number(Deno.env.get("SONNET_OUTPUT_PRICE_PER_M") ?? "10.00");
// How long a batch stays around before cleanup — just tidiness, not a
// correctness requirement (the app only ever reads the latest batch_date).
const RETENTION_DAYS = 14;

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// The two "mainstream" trending picks — whatever's genuinely getting
// widespread attention today, across any category (not scoped to a single
// beat like the old World News/Science/Technology fields).
//
// Confirmed live in testing: two independent calls with the SAME prompt
// converge on the same single biggest story far more often than you'd
// expect (both picked "Iran Retaliation Threat" the first time this ran,
// worded slightly differently — clearly two separate calls, not a cache
// hit). excludeTopics alone doesn't prevent this: it only excludes each
// field's own PAST picks, and the two fields run concurrently within the
// same batch, so neither has any way to see what the other just found.
// Fixed by giving them different jobs instead of the same one: "primary"
// explicitly goes for the single biggest story, "secondary" is told to
// find a genuinely different major story and specifically NOT the most
// dominant one. Differently-framed prompts collide far less than
// identically-framed ones searching independently for "the" top story.
function trendingMainstreamPrompt(excludeTopics: string[], variant: "primary" | "secondary"): string {
  const today = new Date().toISOString().slice(0, 10);
  const excludeBlock = excludeTopics.length
    ? `\n\nAlready shown recently — pick something genuinely different from all of these, not a rephrasing of any of them: ${excludeTopics.join("; ")}.`
    : "";
  const focusLine =
    variant === "primary"
      ? `Search for the single biggest, most dominant story trending right now — whatever is getting the most attention today, in any category (politics, business, entertainment, sports, culture, tech — whatever is actually trending, not a fixed beat).`
      : `Search for a second, genuinely different major story trending right now — something else that's also getting real, widespread attention today, but NOT the single most dominant headline (assume that one's already covered elsewhere). Pick a different category if you can — if the biggest story is political, look at business, culture, sports, or tech instead.`;
  return `Today's date is ${today}. You have live web search — use it now.

${focusLine} Use a specific, well-targeted query rather than a generic phrase like "trending today" — try a different angle or refine the query if the first search doesn't surface something with real current buzz behind it.${excludeBlock}

The underlying EVENT itself has to be genuinely fresh — something that actually happened or was announced within roughly the last 48 hours, not an older story that's merely being reposted, re-discussed, or resurfacing as an anniversary. Check the actual date of the event you find, not just the date of the page reporting it — a page published today about something that happened weeks or months ago does NOT count as trending. If what you find turns out to be old once you check, search again with a more time-boxed query (add "today," "this week," or today's actual date to it) until you land on something truly current.

Current, specific, and fresh — no historical background or context. The topic and teaser must be about a specific thing that happened or was announced recently, not general facts about the subject. A reader should immediately understand what's NEW, not get a primer on the subject.

Once you've found a real, currently-trending story, produce:
- "topic": a short, punchy 2-5 word label suitable as a one-tap starting point for someone exploring the topic (title case, no trailing punctuation) — name the current event/development, not just the subject's name
- "teaser": one enticing sentence (max 20 words) describing the specific development, written to make someone curious to click it
- "source_url": the URL of the real source you found via search, supporting the story — must be a specific page that actually discusses THIS exact story, not a homepage, an unrelated video, or a generic live-updates/liveblog page that merely happens to be from a relevant outlet

${SOURCE_URL_CHECK}

Respond with ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{"topic": "...", "teaser": "...", "source_url": "..."}`;
}

// The one deliberately-offbeat pick — still real and actually trending
// today, just not the single most obvious front-page story. This is what
// gives the section its own personality instead of reading like a wire
// feed (see the "In the news" -> "Trending" conversation this replaced).
function trendingWildcardPrompt(excludeTopics: string[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const excludeBlock = excludeTopics.length
    ? `\n\nAlready shown recently — pick something genuinely different from all of these, not a rephrasing of any of them: ${excludeTopics.join("; ")}.`
    : "";
  return `Today's date is ${today}. You have live web search — use it now.

Search for something genuinely trending right now that's a bit more offbeat or under-the-radar — still real and actually gaining attention today, just not the single most obvious headline everyone already knows. Think: a niche internet moment, an unusual story going viral in a specific community, a strange finding making the rounds, a quirky local story — something a curious person would be delighted to stumble onto rather than something they already saw on the front page. It still needs to be real, verifiable, and genuinely happening/trending today — not evergreen trivia dressed up as news.${excludeBlock}

The underlying EVENT itself has to be genuinely fresh — something that actually started gaining attention within roughly the last 48 hours, not an old story resurfacing or an evergreen "weird fact" being passed off as current. Check the actual date of the event/moment you find, not just the date of the page reporting it — a page published today about something from weeks or months ago does NOT count as trending. If what you find turns out to be old once you check, search again with a more time-boxed query until you land on something truly current.

Current, specific, and fresh — no historical background or context. Lead with the actual current development, not a primer on the subject.

Once you've found a real, currently-trending story, produce:
- "topic": a short, punchy 2-5 word label suitable as a one-tap starting point for someone exploring the topic (title case, no trailing punctuation)
- "teaser": one enticing sentence (max 20 words) describing the specific development, written to make someone curious to click it
- "source_url": the URL of the real source you found via search, supporting the story — must be a specific page that actually discusses THIS exact story, not a homepage, an unrelated video, or a generic live-updates/liveblog page that merely happens to be from a relevant outlet

${SOURCE_URL_CHECK}

Respond with ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{"topic": "...", "teaser": "...", "source_url": "..."}`;
}

// Appended to every prompt's source_url instruction. Confirmed live that
// just telling the model "must be specific, not a homepage" wasn't enough
// on its own — a source still came back as a bare "cnn.com/business"
// section front. This adds a concrete, checkable rule (what a generic URL
// actually looks like) plus an explicit instruction to go back and fix it
// rather than submit a URL that fails the check, instead of leaving
// "specific" to the model's own judgment alone.
const SOURCE_URL_CHECK = `Before finalizing, check your own source_url against this: a bare domain, a short generic section path (like ".../business", ".../news", ".../world"), or a rolling live-updates/liveblog page covering many unrelated stories — anything that isn't one page specifically about THIS story — means you defaulted to a generic page instead of a real one. If that's what you have, first try to fix it: pick a genuinely specific result from your search (a URL with a real headline-shaped path, not just a section or liveblog) or search again with a more targeted query.

That said, you must still answer. Never respond by saying you couldn't find one, giving a meta-answer about your own search process, or leaving source_url empty/null — those responses are worse than an imperfect one and will break the app that reads this. If your best result after trying still isn't a perfectly specific page, use it anyway: a real story with an imperfect source beats no answer at all.`;

// Kept as a fallback for any field name that isn't one of the special
// date-anchored ones or the trending picks above — not exercised by
// NEWS_FIELDS today, but harmless to leave in place for a future field.
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
- "source_url": the URL of the real source you found via search, supporting the story — must be a specific page that actually discusses THIS exact story, not a homepage, an unrelated video, or a generic live-updates/liveblog page that merely happens to be from a relevant outlet

${SOURCE_URL_CHECK}

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
- "source_url": the URL of a real source confirming this observance falls on this date — a specific page actually about it, not a homepage or unrelated page

${SOURCE_URL_CHECK}

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

Search for a real, verifiable, genuinely interesting event that happened specifically on ${monthDay} in history — any past year. Deliberately favor something local or regional in scale — a specific city, town, state/province, or community — over a globally famous, world-shaping event (a war, a treaty, a national election, and the like). The kind of thing a local newspaper archive or regional historical society would cover, not a world-history textbook chapter. It still needs to be surprising or genuinely interesting, not just obscure for its own sake, and it must be historically accurate and confirmable via search, not misremembered trivia.${excludeBlock}

Once you've confirmed a real event via search, produce:
- "topic": a short punchy 2-6 word label naming the event (title case, no trailing punctuation, no year)
- "teaser": one enticing sentence (max 20 words) describing what happened — may include the year and place — written to make someone curious to click
- "source_url": the URL of a real source confirming this event and date — a specific page actually about it, not a homepage or unrelated page

${SOURCE_URL_CHECK}

Respond with ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{"topic": "...", "teaser": "...", "source_url": "..."}`;
}

function wordOfTheDayPrompt(excludeTopics: string[]): string {
  const excludeBlock = excludeTopics.length
    ? `\n\nAlready featured recently — pick a different word this time, not a repeat of any of these: ${excludeTopics.join("; ")}.`
    : "";
  return `You have live web search — use it now.

Pick a single real English word — common enough that most readers will already recognize it — with a genuinely surprising, verifiable etymology or origin story, the kind of thing that makes someone say "wait, really?" Avoid a word whose origin story is already common knowledge. Search to confirm the etymology is real and accurate, not a popular folk etymology that turns out to be false.${excludeBlock}

Once you've confirmed a real one via search, produce:
- "topic": the word itself, title case, no definition or extra text
- "teaser": one enticing sentence (max 20 words) that reveals the surprising part of its origin, written to make someone curious to click and learn more
- "source_url": the URL of a real source confirming this etymology — a specific page actually about it, not a homepage or unrelated page

${SOURCE_URL_CHECK}

Respond with ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{"topic": "...", "teaser": "...", "source_url": "..."}`;
}

function promptForField(field: string, excludeTopics: string[]): string {
  if (field === "National Day") return nationalDayPrompt(excludeTopics);
  if (field === "This Day In History") return thisDayInHistoryPrompt(excludeTopics);
  if (field === "Word Of The Day") return wordOfTheDayPrompt(excludeTopics);
  if (field === TRENDING_WILDCARD_FIELD) return trendingWildcardPrompt(excludeTopics);
  if (field === TRENDING_MAINSTREAM_FIELDS[0]) return trendingMainstreamPrompt(excludeTopics, "primary");
  if (field === TRENDING_MAINSTREAM_FIELDS[1]) return trendingMainstreamPrompt(excludeTopics, "secondary");
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
        // allowed_domains only for the mainstream fields — see
        // TRUSTED_MAINSTREAM_DOMAINS above for why it's scoped that way.
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 2,
            ...(TRENDING_MAINSTREAM_FIELDS.includes(field) ? { allowed_domains: TRUSTED_MAINSTREAM_DOMAINS } : {}),
          },
        ],
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
  const sourceUrl = (parsed.source_url || "").trim();
  // source_url is required, not best-effort — confirmed live that without
  // this, a model response that gave up (topic: "Search Inconclusive",
  // source_url: null) passed validation and got published straight to
  // trending_topics_cache as if it were a real pick. Rejecting it here
  // means that field just fails for this run (Promise.allSettled already
  // tolerates individual field failures) instead of shipping a broken
  // card to real users.
  if (!topic || !teaser || !sourceUrl) {
    throw new Error(`Missing topic/teaser/source_url: ${cleaned.slice(0, 300)}`);
  }

  // Real usage, not the estimate in the pricing spreadsheet — every field
  // call is non-streaming, so it's a single JSON response with usage
  // already attached, no SSE parsing needed (contrast rabbit-hole-proxy,
  // which has to tee a stream for this).
  const inputTokens: number | null = data?.usage?.input_tokens ?? null;
  const outputTokens: number | null = data?.usage?.output_tokens ?? null;
  const costUsd =
    inputTokens != null && outputTokens != null
      ? (inputTokens / 1_000_000) * INPUT_PRICE_PER_M + (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_M
      : null;

  return {
    field,
    topic,
    teaser,
    source_url: sourceUrl,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    model: MODEL,
    cost_usd: costUsd,
  };
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

  // Trending 1 and 2 specifically run SEQUENTIALLY, not concurrently with
  // everything else — confirmed live that running them in parallel (each
  // blind to what the other just found) let them converge on the same
  // underlying story often enough to matter, even with the "secondary"
  // prompt explicitly told to avoid the dominant headline. Running
  // secondary after primary and handing it primary's REAL topic as an
  // extra exclusion (on top of its own past-picks history) actually
  // guarantees no overlap instead of just hoping the category-based
  // framing keeps them apart. Costs a few extra seconds of wall time,
  // irrelevant for a twice-daily background cron job.
  const sequentialFields = fieldsToRun.filter((f) => TRENDING_MAINSTREAM_FIELDS.includes(f));
  const otherFields = fieldsToRun.filter((f) => !TRENDING_MAINSTREAM_FIELDS.includes(f));

  const orderedFields: string[] = [];
  const results: any[] = [];

  let justPicked: string[] = [];
  for (const field of sequentialFields) {
    orderedFields.push(field);
    try {
      const value = await generateForField(apiKey, field, [...(recentByField[field] || []), ...justPicked]);
      results.push({ status: "fulfilled", value });
      justPicked = [...justPicked, value.topic];
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }

  const otherResults = await Promise.allSettled(
    otherFields.map((field) => generateForField(apiKey, field, recentByField[field] || []))
  );
  orderedFields.push(...otherFields);
  results.push(...otherResults);

  const rows: any[] = [];
  const errors: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      rows.push({ batch_date: today, ...r.value });
    } else {
      console.error(`generate-trending-topics: field "${orderedFields[i]}" failed`, r.reason);
      errors.push(`${orderedFields[i]}: ${r.reason}`);
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
