// Supabase Edge Function: rabbit-hole-proxy
//
// Holds the real Anthropic API key server-side and is the ONLY thing that
// ever calls api.anthropic.com for this app. The client never sees the key
// and never talks to Anthropic directly — see the handoff README's Phase 1
// plan for why (the old claude.ai-artifact version got auth for free from
// that environment; a standalone deployment has to provide it itself).
//
// Every request is logged (best-effort, non-blocking) to the
// rabbit_hole_request_logs table before being forwarded — timestamp,
// anonymous session id, and endpoint label — purely so Phase 2's per-person
// usage caps can be set from real numbers instead of a guess. Logging
// failures never block or fail the actual Claude request.
//
// Phase 2 (accounts + usage limits) plugs in here as a check added in
// front of the forward step below, using the same request/response shape —
// not a parallel path or a second function.
//
// Interim safety net (not real Phase 2 accounts, just a cost ceiling before
// that exists): each anonymous session is capped at DAILY_REQUEST_LIMIT
// requests per rolling 24h, counted straight off the log table below. Fails
// OPEN if the count query itself errors — a monitoring hiccup should never
// block a real person's request.
//
// Pre-public-launch hardening added two more layers on top of the
// session-only cap above, since session_id lives in localStorage and is
// trivially reset (incognito, cleared storage, or a script minting a fresh
// one per batch) — it alone can't bound total cost once traffic is public:
//   - DAILY_REQUEST_LIMIT_PER_IP: the same kind of rolling-24h request-count
//     ceiling, keyed on the client's IP (getClientIp below) instead of the
//     client-controlled session id. Higher than the per-session limit on
//     purpose — a shared office/campus/carrier-NAT IP can legitimately be
//     many real people, and this is a backstop against a script, not a
//     precise per-person quota.
//   - GLOBAL_DAILY_SPEND_LIMIT_USD: the real one. Sums actual measured
//     Anthropic cost (rabbit_hole_request_logs.cost_usd, via the
//     get_recent_spend_usd DB function) across ALL free/unfunded traffic in
//     the last 24h, and stops serving new free-tier requests once it's
//     crossed — many distinct sessions/IPs each staying under their own
//     ceiling can still add up to real money, which neither cap above
//     catches on its own. Funded callers are exempt: their spend is
//     already self-limiting (deduct_balance can't take more than their own
//     balance holds), so this is specifically a free-tier backstop, not a
//     "the whole app is down" switch.
//
// News/Today root caching: a topic from the "In the news"/"Today" hero
// cards is identical for every visitor until the next
// generate-trending-topics refresh, so the client tags those root calls
// with `newsCacheKey` (the exact topic string) so this can skip straight to
// a cached response instead of generating again on a hit.
//
// Writing the cache is a SEPARATE, later request (`newsCacheWrite`, below),
// sent by the client only after it has finished streaming and parsed the
// result. An earlier version forced the generation itself to be
// non-streaming so THIS request could await-and-cache the result inline —
// that added a real 1-2s of visible latency on every cache miss, since the
// client then had to wait for the entire generation to finish before
// seeing anything, instead of watching it stream in like any other topic.
// Splitting the write into its own request keeps the cheap read-then-
// maybe-serve-cached check here, while the generation itself — hit or miss
// — always streams normally. This also means the response-streaming
// pass-through below is never touched by the caching feature at all, hit
// or miss — see the revert in git history for why that path stays
// especially conservative.
//
// Free-trial enforcement (production punch list, Section B; see the
// monetization outline doc, Section 14.1/14.2): "root" calls (typing a
// topic, or clicking a News/Today card — the "Dig In" action) are never
// blocked themselves. What's metered is "article" calls specifically —
// every genuinely fresh page dug into, whether that's a root topic's own
// auto-loaded read-more, or any child reached via an "explore next" chip,
// an in-text link, or a highlighted custom exploration. That's exactly
// one article generation per new node regardless of entry point, so it
// counts uniformly no matter how someone got there — re-reading an
// already-loaded node makes no new call at all (cached client-side), and
// "dig deeper" (continuation) extends an existing page rather than
// opening a fresh one, so it's correctly never counted either. Counted
// per "trial day" — a hard reset at 3:00 AM in the visitor's own local
// timezone (see trialDayStartIso below), not a rolling 24h window from
// each individual search. A rolling window meant someone's count ticked
// back down gradually all day as old searches aged out one by one, which
// read as confusing/unpredictable; a single fixed overnight cutoff is
// one clean number to reset to. Local-timezone rather than one fixed
// zone for everyone, since "3am" only reads as "overnight" if it's 3am
// where the person actually is — the client sends its IANA timezone
// (Intl.DateTimeFormat().resolvedOptions().timeZone, see api.js's
// timeZoneField) with every call; an invalid or missing one falls back
// to America/New_York (DEFAULT_TIME_ZONE below) rather than failing the
// request. This is trivially spoofable (nothing stops a client from
// lying about its timezone to reset early) — an accepted trade-off,
// consistent with Section 14.2's existing "loosely gated, not
// hard-walled" posture for the free tier. Once a non-funded
// identity has made FREE_SEARCH_LIMIT of these since that cutoff, the
// three "rich" functions — expand, article, and continuation —
// are blocked (GATED_ENDPOINTS below), with one deliberate exception: a
// root topic's own auto-loaded read-more article is never blocked either,
// so typing a brand new topic always gets a full standalone page (title +
// overview + body text), even with the trial exhausted — it just can't be
// branched into any further (no expand, no child articles, no dig
// deeper/continuation) until funded. A signed-in user
// counts against their real account (verified via their access token,
// never a client-supplied id); an anonymous visitor still counts against
// their browser's session_id, per Section 14.2's deliberate choice to
// keep the free tier loosely gated rather than hard-walled. A funded
// account (profiles.balance_usd > 0) skips this gate entirely.
//
// Billing (production punch list, Section D): real balance drawdown per
// action, added alongside the Stripe top-up flow (create-checkout-session/
// stripe-webhook). A funded caller's balance is deducted after each call,
// from the real measured Anthropic cost marked up to the decided 50%
// margin target — see extractUsageAndBill/computeCostUsd below. This never
// touches the streaming pass-through response itself (see that section's
// comment for why that path stays especially conservative) — it reads a
// clone() of the response in the background instead.
//
// DEPLOY STEPS:
//   1. supabase functions new rabbit-hole-proxy
//   2. Replace the generated index.ts with this file's contents
//   3. supabase secrets set ANTHROPIC_API_KEY=your_actual_key_here
//   4. Run the migrations in supabase/migrations
//   5. supabase functions deploy rabbit-hole-proxy

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Production punch list, Section J: this shipped as a wide-open "*" for a
// long time (fine while nothing but this app's own domain ever called it,
// but never actually locked down). Now echoes the request's Origin back
// only when it's in the allowlist below, so a browser on some other site
// can't read this function's responses at all — Access-Control-Allow-Origin
// has to exactly match the calling origin (not "*") for that to work.
// Includes local dev ports since testing against the live deployed
// function from `npm run dev` is routine for this project; override/extend
// via the ALLOWED_ORIGINS secret (comma-separated) without a code change.
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
    // Browsers only expose the CORS safelist headers to JS by default — a
    // custom header is invisible to fetch()'s res.headers.get() client-side
    // without this, even though it's plainly there on the wire.
    "Access-Control-Expose-Headers":
      "X-Session-Actions-Today, X-Trial-Searches-Used, X-Trial-Search-Limit, X-Trial-Funded",
  };
}

// Phase 1 of the tiered-usage design (see conversation notes — pure
// instrumentation, nothing gated on this yet): surfaces the same rolling
// 24h count already computed below for the DAILY_REQUEST_LIMIT check, so
// the client can show what tier a session would currently be in without a
// second query. +1 accounts for the request this response is answering,
// since `count` was queried before it — logRequest() below may or may not
// have landed yet by the time this header is read.
function usageHeaders(count: number | null) {
  return { "X-Session-Actions-Today": String((count ?? 0) + 1) };
}

// Endpoints gated by the free-trial search limit — "root" (Dig In) is
// deliberately not in this set; see the top-of-file note.
const GATED_ENDPOINTS = new Set(["expand", "article", "continuation"]);

// Overridable without a redeploy, same pattern as DAILY_REQUEST_LIMIT.
// Started at 6 (the monetization outline's Section 14.1 placeholder);
// lowered to 4 once real data showed 90% of anonymous readers open 2 or
// fewer fresh pages a day.
const FREE_SEARCH_LIMIT = Number(Deno.env.get("FREE_SEARCH_LIMIT") ?? "4");
// A free account gets more than an anonymous visitor, so signing up is
// worth something — the limit's own message offers exactly that.
const SIGNED_IN_SEARCH_LIMIT = Number(Deno.env.get("SIGNED_IN_SEARCH_LIMIT") ?? "10");

function searchLimitFor(userId: string | null) {
  return userId ? SIGNED_IN_SEARCH_LIMIT : FREE_SEARCH_LIMIT;
}

function trialHeaders(searchesUsed: number, funded: boolean, limit: number) {
  return {
    "X-Trial-Searches-Used": String(searchesUsed),
    "X-Trial-Search-Limit": String(limit),
    "X-Trial-Funded": funded ? "1" : "0",
  };
}

// Fixed server-side, deliberately not read from the client request (the
// admin Tone Lab's modelOverride is the one exception, admin-only).
//
// Haiku 4.5, chosen in a blind side-by-side in the admin Tone Lab against
// Sonnet 5 and Haiku 5.5 once Haiku had its own voice corrections and
// example turns (see HAIKU_VOICE_REFERENCE / HAIKU_ARTICLE_EXAMPLES): same
// voice to the operator's eye, faster and about half the price. Sonnet 5
// was the model before that.
//
// Its own secret name, PROXY_MODEL, NOT the shared "MODEL" secret —
// generate-trending-topics reads "MODEL" too (secrets are project-wide),
// and the daily hero picks (live web search, fact-checking) should stay on
// Sonnet regardless of what reader-facing text runs on. Set
// `supabase secrets set PROXY_MODEL=claude-sonnet-5` to switch back
// without a redeploy.
const MODEL = Deno.env.get("PROXY_MODEL") ?? "claude-haiku-4-5";
// The legacy separate "root" call (overview + chips) — the app no longer
// makes it (topic pages start with their article), kept only for any old
// client still calling it. Overridable separately via ROOT_MODEL.
const ROOT_MODEL = Deno.env.get("ROOT_MODEL") ?? MODEL;

// Models the admin Tone Lab may switch to (see effectiveModel in serve()).
const TONE_LAB_MODELS = new Set(["claude-sonnet-5", "claude-haiku-4-5", "claude-haiku-5-5"]);

// Haiku-only voice corrections. The tone rules in the client's system
// prompt were hand-tuned against Sonnet's writing; Haiku follows the same
// rules but reads them flatter — confirmed live in the admin Tone Lab:
// Haiku 5.5 came out "flat, too encyclopedic." Two things fix that for a
// smaller model far better than more adjectives: closing off the specific
// instruction it over-obeys (the article task's "dial the energy back and
// plainly define the topic" first paragraph, which Sonnet treats as one
// clause and Haiku turns into a textbook paragraph), and showing the voice
// as worked examples in the conversation itself (HAIKU_ARTICLE_EXAMPLES).
// Applied only for Haiku, so Sonnet's prompt — the reference voice — stays
// byte-for-byte unchanged. Cached as its own block (same 1h TTL as the
// client's), so it costs a cache read per call, not full input price.
const HAIKU_VOICE_REFERENCE = `=== VOICE CORRECTIONS — these override anything above that pulls the other way ===
The tone section is the most important instruction in this prompt: readers come back for the voice as much as the facts. The example articles earlier in this conversation are written in exactly the right voice — match their energy, rhythm and specificity, never their facts, topics or phrases.

- Where the article task says to dial the energy back and plainly define the topic in the first paragraph, that means ONE plain clause at most, not a paragraph. The voice stays on in every other sentence.
- The first sentence is a hook that lands on its own: a cold number, a vivid image, or a flat claim that sounds wrong until it's explained.
- Encyclopedic tells — never write these: opening with "[Topic] is a / an / the...", "refers to", "is known as", "is defined as", "is a type of", "Scientists believe", passive textbook voice ("it is thought that," "it has been shown"), a sentence that lists three facts with no reaction, and any closing summary ("Overall," "In short," "Ultimately," "Today, X remains...").
- Every paragraph needs at least one moment of attitude: an object given a personality, an absurd-but-accurate comparison, or a short deadpan sentence reacting to the fact.
- Sentence length swings hard: a long breathless run held together by commas and dashes, then a short flat sentence that lands the punch.
- Everything is specific: names, numbers, mechanisms, places. No vague intensifiers ("incredible," "amazing," "fascinating," "truly") and no filler ("it's worth noting," "interestingly").
- It sounds like an excited expert telling a friend something they can't believe — not an encyclopedia, a textbook or a press release.`;

// Real Sonnet-written articles from the cache, trimmed to today's article
// length and with any phrase the tone rules ban as a crutch taken out.
// Given to Haiku as earlier turns of the conversation (user prompt in the
// app's real format, its "own" answer in the right voice) rather than
// quoted in the system prompt — a smaller model copies a voice from its
// own prior answers much more faithfully. Article calls only.
const HAIKU_ARTICLE_EXAMPLES = [
  {
    user: `TASK: read-more article

Today's date is 2026-10-05.

Path so far: Sarcasm
Topic: "Sarcasm"

Begin with a title line.`,
    assistant: `TITLE: Sarcasm

Rip into the etymology of sarcasm and you find actual torn flesh waiting underneath. The word traces back to the Greek "sarkazein," meaning to tear flesh or strip off skin — the exact same brutal root that gave us [[sarcophagus]], the stone coffin literally named for its job of devouring corpses. Somewhere along the way, Greek speakers started using that same violent image for snarling like a dog, then narrowed it into speaking with bitter, cutting contempt.

The aggression never left. Understanding sarcasm requires catching the gap between what's said and what's meant, which is why [[brain damage]] to certain right-hemisphere regions can strip people of the ability to hear it at all while their grammar stays perfectly intact. Tearing flesh, it turns out, was never just a metaphor for cruelty — it's an uncannily precise description of what a well-aimed sarcastic remark does to whoever's on the receiving end.`,
  },
  {
    user: `TASK: read-more article

Today's date is 2026-10-05.

Path so far: why does bread go stale → Starch Retrogradation
Topic: "Starch Retrogradation"`,
    assistant: `Your bread was never actually a solid in the way you think — it's a crystal that got murdered by heat and spends its entire shelf life trying to resurrect itself. Flour starch comes packed in tight, orderly granules of two molecules, amylose and amylopectin. Baking blasts that order apart: water floods in, the chains uncoil, and the granules swell and burst in a process called [[gelatinization]], the only reason fresh bread has a soft crumb at all.

But the molecules don't forget who they were. The second the loaf cools, amylose snaps back into tight [[double helix]] bundles within hours, while branchier amylopectin spends days crawling back toward crystal order, dragging moisture out of the crumb as it goes. That runs fastest around four degrees Celsius — fridge temperature — so fridge bread stales roughly six times faster than bread on the counter. Freeze it instead and everything locks in place, which is exactly why freezer bread toasts back to life and fridge bread turns into a brick by Tuesday.`,
  },
  {
    user: `TASK: read-more article

Today's date is 2026-10-06.

Path so far: Pennsylvania Bear Breaks Into Restaurant
Topic: "Pennsylvania Bear Breaks Into Restaurant"

Begin with a title line.`,
    assistant: `TITLE: Bear Walks Into Restaurant

A black bear walked straight up to the host stand of a Pennsylvania restaurant like it had a reservation, looked things over, then turned around and went dumpster diving out back. Security footage caught the whole visit, and it is exactly as calm as it sounds — no screaming staff, no stampede, just a four-hundred-pound animal clocking the lobby decor before heading for the real destination. To a nose that can smell food from over a mile away, a restaurant dumpster is basically an all-you-can-eat buffet, and this bear clearly knew the menu before it walked in.

It's also becoming routine. As [[black bear populations]] spread into suburbs and strip malls, bears treat buildings as an extension of the forest floor, and once one learns a dumpster pays off it comes back, sometimes for years, thanks to an excellent [[spatial memory]] for food. Pennsylvania alone holds around twenty thousand black bears — enough that a bear browsing a lobby isn't a freak accident anymore, it's a scheduling issue.`,
  },
];

// Appends the Haiku voice corrections after the client's own (cached)
// system blocks. Anything else — Sonnet, or a caller that sent a plain
// string — passes through untouched.
function withVoiceReference(system: unknown, model: string): unknown {
  if (!model.includes("haiku") || !Array.isArray(system)) return system;
  return [...system, { type: "text", text: HAIKU_VOICE_REFERENCE, cache_control: { type: "ephemeral", ttl: "1h" } }];
}

// Puts HAIKU_ARTICLE_EXAMPLES in front of a Haiku article request as
// earlier turns, with a cache breakpoint on the last one so the whole
// fixed prefix (system + examples) is a cache read on every later call.
function withArticleExamples(messages: unknown, model: string, endpoint: string): unknown {
  if (!model.includes("haiku") || endpoint !== "article" || !Array.isArray(messages)) return messages;
  const turns: unknown[] = [];
  HAIKU_ARTICLE_EXAMPLES.forEach((ex, i) => {
    const last = i === HAIKU_ARTICLE_EXAMPLES.length - 1;
    turns.push({ role: "user", content: ex.user });
    turns.push({
      role: "assistant",
      content: [{ type: "text", text: ex.assistant, ...(last ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}) }],
    });
  });
  return [...turns, ...messages];
}

// Same env var names generate-trending-topics uses for its own cost
// calculation — Supabase secrets are project-wide, so one value covers
// both functions. A future Anthropic price change only needs setting once.
// These are Sonnet's rates; Haiku models are priced from
// MODEL_PRICES_PER_M below instead, so the PROXY_MODEL switch to Haiku
// bills at Haiku's own rates with no secret change needed.
const INPUT_PRICE_PER_M = Number(Deno.env.get("SONNET_INPUT_PRICE_PER_M") ?? "2.00");
const OUTPUT_PRICE_PER_M = Number(Deno.env.get("SONNET_OUTPUT_PRICE_PER_M") ?? "10.00");
// Anthropic's published multipliers for a 1h cache TTL (this app's
// systemBlock() in src/lib/api.js always requests ttl: "1h") — a cache
// write costs 2x the base input rate, a cache read costs 10% of it.
const CACHE_WRITE_MULTIPLIER = 2.0;
const CACHE_READ_MULTIPLIER = 0.1;

// Billing (production punch list, Section D): the margin target decided
// for the $10 minimum balance (monetization outline doc, Section 14.1) is
// 50%, so a funded user's balance is deducted at 1 / (1 - 0.5) = 2x the
// real measured Anthropic cost of each call — a $10 balance buys ~$5 of
// real usage, matching 14.1's table. The credited amount itself (in
// stripe-webhook) is never marked up — only the spend rate is.
const MARGIN_TARGET = Number(Deno.env.get("BILLING_MARGIN_TARGET") ?? "0.5");
const BILLING_MARKUP_MULTIPLIER = 1 / (1 - MARGIN_TARGET);

// Real per-call cost from Anthropic's own `usage` object, in the same
// shape whether it came from a non-streamed response or was reconstructed
// from an SSE stream's message_start/message_delta events (see
// extractUsageAndBill below).
//
// Haiku models have their own published per-MTok rates; anything else
// (today's Sonnet) uses the SONNET_*_PRICE_PER_M secrets above. Keyed by
// exact model id so a MODEL secret switch to a Haiku bills correctly
// without touching those secrets.
const MODEL_PRICES_PER_M: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
function computeCostUsd(
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  model: string = MODEL
) {
  const prices = MODEL_PRICES_PER_M[model] ?? { input: INPUT_PRICE_PER_M, output: OUTPUT_PRICE_PER_M };
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (input / 1_000_000) * prices.input +
    (output / 1_000_000) * prices.output +
    (cacheWrite / 1_000_000) * prices.input * CACHE_WRITE_MULTIPLIER +
    (cacheRead / 1_000_000) * prices.input * CACHE_READ_MULTIPLIER
  );
}

// Anthropic's streaming response never carries one single `usage` object —
// input/cache-token counts arrive on message_start, and the true final
// output-token count arrives on the *last* message_delta before the
// stream ends (each message_delta's usage.output_tokens is the running
// total so far, not an incremental delta — last one wins). Best-effort:
// any line that doesn't parse as JSON, or isn't one of these two event
// types, is just skipped.
function parseSSEUsage(sseText: string) {
  let inputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let outputTokens = 0;
  let sawUsage = false;
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr || jsonStr === "[DONE]") continue;
    let evt: any;
    try {
      evt = JSON.parse(jsonStr);
    } catch {
      continue;
    }
    if (evt.type === "message_start" && evt.message?.usage) {
      inputTokens = evt.message.usage.input_tokens ?? 0;
      cacheCreation = evt.message.usage.cache_creation_input_tokens ?? 0;
      cacheRead = evt.message.usage.cache_read_input_tokens ?? 0;
      sawUsage = true;
    } else if (evt.type === "message_delta" && evt.usage) {
      outputTokens = evt.usage.output_tokens ?? outputTokens;
      sawUsage = true;
    }
  }
  if (!sawUsage) return null;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
}

// Supabase Edge Functions keep running background work queued via
// EdgeRuntime.waitUntil even after the response has already been sent to
// the client — without it, the isolate can be frozen/recycled the moment
// the response is returned, and a fire-and-forget promise might never
// finish. Falls back to a plain unattached promise (best effort, same as
// logRequest's existing posture) if that global isn't present, e.g. when
// running under a different Deno host locally.
function background(promise: Promise<unknown>) {
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") {
    rt.waitUntil(promise);
  } else {
    promise.catch((e) => console.error("rabbit-hole-proxy: background task failed", e));
  }
}

// Reads a *clone* of the real Anthropic response to work out what it
// actually cost, entirely independent of the clone that gets streamed
// back to the client — clone() tees the underlying body, so this never
// touches, delays, or risks the client-facing pass-through response. Logs
// the real cost onto this request's log row (Section K's "measure it for
// real" numbers) and, for a signed-in caller, deducts the marked-up
// amount from their balance via the atomic deduct_balance function.
//
// Latency: `anthropicCallStartedAt` is captured right before the fetch to
// Anthropic; this function's clone-read (meterRes.json()/.text()) doesn't
// resolve until the *entire* body has arrived, at the same pace as the
// real client-facing stream (both clones are fed from the same underlying
// source). So Date.now() at that point, minus the start time, is a real
// measurement of generation+streaming duration — not just
// time-to-first-byte, and not just an output-token-count proxy. It omits
// only the last small hop from this function to the actual browser, which
// isn't the variable cost driver anyway (generation time is).
// Shared by both a real generation (extractUsageAndBill below) and a
// cache-hit article read (see the newsCacheKey/"article" branch in serve())
// — logs the real/attributed cost onto this request's log row and, for a
// signed-in caller, deducts the marked-up amount from their balance via the
// atomic deduct_balance function. Pulled out on its own specifically so a
// cache hit can charge like a fresh search too, using the ORIGINAL
// generation's stored usage (see news_root_cache's article_input_tokens/
// article_output_tokens) — without this, every visitor after the first to
// open a given Trending/Today/Quote card got that page for free, which
// matters a lot given most traffic starts from the hero page.
async function billAndLog(
  usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
  logRowIdPromise: Promise<number | null>,
  userId: string | null,
  latencyMs: number | null,
  model: string = MODEL
) {
  const costUsd = computeCostUsd(usage, model);

  const rowId = await logRowIdPromise;
  if (rowId != null) {
    const { error } = await supabase
      .from("rabbit_hole_request_logs")
      .update({
        model,
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cost_usd: costUsd,
        latency_ms: latencyMs,
      })
      .eq("id", rowId);
    if (error) console.error("rabbit-hole-proxy: failed to log real cost", error);
  }

  if (userId) {
    const { error } = await supabase.rpc("deduct_balance", {
      p_user_id: userId,
      p_amount: costUsd * BILLING_MARKUP_MULTIPLIER,
    });
    if (error) console.error("rabbit-hole-proxy: failed to deduct balance", error);
  }
}

// cacheContext is set only for a genuinely fresh (non-cached) article
// generation tied to a newsCacheKey — when present, this also persists the
// real usage onto news_root_cache (best-effort, first-write-wins via
// .is(..., null)) so a LATER cache hit for the same topic can bill readers
// the same real cost via billAndLog above, instead of serving it for free.
async function extractUsageAndBill(
  meterRes: Response,
  logRowIdPromise: Promise<number | null>,
  userId: string | null,
  anthropicCallStartedAt: number,
  cacheContext?: { newsCacheKey: string; endpoint: string },
  model: string = MODEL
) {
  try {
    const contentType = meterRes.headers.get("Content-Type") || "";
    let usage: ReturnType<typeof parseSSEUsage> = null;
    if (contentType.includes("application/json")) {
      const data = await meterRes.json();
      usage = data?.usage ?? null;
    } else {
      usage = parseSSEUsage(await meterRes.text());
    }
    if (!usage) return;

    const latencyMs = Date.now() - anthropicCallStartedAt;
    await billAndLog(usage, logRowIdPromise, userId, latencyMs, model);

    if (cacheContext?.endpoint === "article" && cacheContext.newsCacheKey) {
      const { error } = await supabase
        .from("news_root_cache")
        .update({ article_input_tokens: usage.input_tokens ?? 0, article_output_tokens: usage.output_tokens ?? 0 })
        .eq("cache_key", cacheContext.newsCacheKey)
        .is("article_input_tokens", null);
      if (error) console.error("rabbit-hole-proxy: failed to persist article usage for caching", error);
    }
  } catch (e) {
    console.error("rabbit-hole-proxy: usage/billing extraction failed", e);
  }
}

// Per-session-per-day request ceiling — overridable without a redeploy via
// `supabase secrets set DAILY_REQUEST_LIMIT=...`. 300 is generous headroom
// for genuinely heavy single-day use while still catching a runaway loop
// or a link forwarded well past the "friends" scale this key is sized for.
const DAILY_REQUEST_LIMIT = Number(Deno.env.get("DAILY_REQUEST_LIMIT") ?? "300");
// Same idea, keyed on client IP instead of session id — see the top-of-file
// note on why session_id alone isn't a safe enough identity once traffic is
// public. Deliberately higher than DAILY_REQUEST_LIMIT: a shared IP (office,
// campus, mobile carrier NAT) can be many real people, so this needs to be
// loose enough not to collide with real-but-heavy legitimate traffic while
// still catching a script that mints a fresh session_id per batch from one
// machine/IP.
const DAILY_REQUEST_LIMIT_PER_IP = Number(Deno.env.get("DAILY_REQUEST_LIMIT_PER_IP") ?? "900");
// The real backstop — total measured Anthropic spend (not request count)
// across all free/unfunded traffic in the last 24h. Set this to whatever
// dollar figure you're actually comfortable risking on the free tier in a
// worst case; $50 is a placeholder starting point, not a researched number.
// Overridable via `supabase secrets set GLOBAL_DAILY_SPEND_LIMIT_USD=...`.
const GLOBAL_DAILY_SPEND_LIMIT_USD = Number(Deno.env.get("GLOBAL_DAILY_SPEND_LIMIT_USD") ?? "50");

// Client IP from the platform's forwarded-for header — Deno Deploy (what
// Supabase Edge Functions run on) sets this to a comma-separated list with
// the real originating client first and any intermediate proxies after;
// x-real-ip is the fallback some edge/CDN layers use instead. Null (not
// "unknown") when neither header is present, same "don't fabricate an
// identity" posture as sessionId's own "unknown" fallback being an explicit
// choice rather than this needing to match it.
function getClientIp(req: Request): string | null {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip");
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Same allowlist admin-usage-stats/admin-review-queue/track-event read —
// used here only to auto-flag is_test on the operator's own visitor_id
// (see logArticleViewEvent below), never as an access gate.
const ADMIN_USER_IDS = new Set(
  (Deno.env.get("ADMIN_USER_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns the inserted row's id (or null on failure) so the billing step
// below can attach the real cost to this same row once the call finishes —
// callers still fire this off unawaited at request start (before the
// Anthropic call), never blocking on the id; only the later background
// billing task actually awaits the returned promise.
// nodeType (direct/indirect/tangent/custom/root) is only meaningful for
// "article"/"continuation" calls — it's which branch type the reader
// actually chose to open, the real signal for which types resonate. Kept
// as a client-supplied value validated against a fixed set rather than
// trusted verbatim, same caution as any other client input, even though
// this is just an analytics column and nothing is gated on it.
const VALID_NODE_TYPES = new Set(["root", "direct", "indirect", "tangent", "custom"]);

async function logRequest(
  sessionId: string,
  endpoint: string,
  userId: string | null,
  nodeType?: string,
  ipAddress?: string | null,
  funded?: boolean,
  heroSource?: string,
  // Grouped into one object rather than three more positional params —
  // the parameter list here was already getting long enough to mix up by
  // position; these three always travel together anyway (see
  // lib/attribution.js, which captures/reads them as one unit).
  attribution?: { utmSource?: string; utmCampaign?: string; rdtCid?: string },
  cacheHit = false,
  isTest = false
): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from("rabbit_hole_request_logs")
      .insert({
        session_id: sessionId || "unknown",
        endpoint: endpoint || "unknown",
        user_id: userId,
        node_type: nodeType && VALID_NODE_TYPES.has(nodeType) ? nodeType : null,
        ip_address: ipAddress ?? null,
        // Captured now, not derived later from profiles.balance_usd — see
        // migration 0032. `undefined` (never explicitly passed) stores as
        // null, same as any row logged before this column existed.
        funded: funded ?? null,
        // Not validated against a fixed enum the way node_type is — the
        // real values are trending_topics_cache field names (drawn from
        // generate-trending-topics' own FIELDS constant, a separate
        // function/file) plus a few synthetic ones from App.jsx
        // (freeform/spin_a_thread/url_param). Analytics-only, nothing is
        // gated on it, so a loose length cap is enough; only actually
        // meaningful for endpoint === "root" (see migration 0033).
        hero_source: typeof heroSource === "string" ? heroSource.slice(0, 60) : null,
        // Ad-attribution (migration 0034) — client-captured once from the
        // URL, attached to every request in a session, not just root.
        utm_source: typeof attribution?.utmSource === "string" ? attribution.utmSource.slice(0, 60) : null,
        utm_campaign: typeof attribution?.utmCampaign === "string" ? attribution.utmCampaign.slice(0, 120) : null,
        rdt_cid: typeof attribution?.rdtCid === "string" ? attribution.rdtCid.slice(0, 120) : null,
        // Served from cache (migration 0051) — still billed, but not
        // counted against the free daily limit (see countSearches).
        cache_hit: cacheHit,
        // The operator's own ?hyfax_test=1 traffic (migration 0052), left
        // out of admin-usage-stats.
        is_test: isTest,
      })
      .select("id")
      .single();
    if (error) throw error;
    return data?.id ?? null;
  } catch (e) {
    // logging is a nice-to-have for Phase 2 planning, never worth failing
    // or even delaying a real user's request over
    console.error("rabbit-hole-proxy: failed to log request", e);
    return null;
  }
}

// Server-side half of the Adoption analytics event log (migration 0049) —
// the client (lib/track.js) logs land/tap/signup itself, but article_view
// is logged here instead, piggybacking on this endpoint's own identity
// resolution (userId) rather than a second client round-trip for every
// article. Mirrors track-event's own visitor/session upsert logic (no
// shared imports across functions in this project, so this is
// intentionally a close duplicate, not a shared helper) — only called for
// endpoint === "article", below. Never allowed to affect the real
// response: every failure here is caught and swallowed, and the call
// itself is fired unawaited.
async function logArticleViewEvent(
  visitorId: unknown,
  sessionId: unknown,
  page: string | null,
  userId: string | null,
  isTest: boolean,
  attribution: { utmSource?: string; utmCampaign?: string; utmContent?: string }
) {
  try {
    if (typeof visitorId !== "string" || typeof sessionId !== "string") return;
    if (!UUID_RE.test(visitorId) || !UUID_RE.test(sessionId)) return;

    const utmSource = typeof attribution.utmSource === "string" ? attribution.utmSource.slice(0, 60) : null;
    const utmCampaign = typeof attribution.utmCampaign === "string" ? attribution.utmCampaign.slice(0, 120) : null;
    const utmContent = typeof attribution.utmContent === "string" ? attribution.utmContent.slice(0, 120) : null;

    const { error: visitorError } = await supabase
      .from("visitors")
      .insert({ visitor_id: visitorId, first_source: utmSource, first_campaign: utmCampaign, first_content: utmContent });
    if (visitorError && visitorError.code !== "23505") {
      console.error("rabbit-hole-proxy: article_view visitor insert failed", visitorError);
    }

    const { error: sessionError } = await supabase
      .from("sessions")
      .insert({ session_id: sessionId, visitor_id: visitorId, utm_source: utmSource, utm_campaign: utmCampaign, utm_content: utmContent });
    if (sessionError && sessionError.code !== "23505") {
      console.error("rabbit-hole-proxy: article_view session insert failed", sessionError);
    }

    const linkIsTest = isTest || (userId !== null && ADMIN_USER_IDS.has(userId));
    if (userId || linkIsTest) {
      const update: Record<string, unknown> = {};
      if (userId) update.user_id = userId;
      if (linkIsTest) update.is_test = true;
      const { error: linkError } = await supabase.from("visitors").update(update).eq("visitor_id", visitorId);
      if (linkError) console.error("rabbit-hole-proxy: article_view visitor link/is_test update failed", linkError);
    }

    const { error: eventError } = await supabase
      .from("events")
      .insert({ visitor_id: visitorId, session_id: sessionId, type: "article_view", page: page ? page.slice(0, 200) : null });
    if (eventError) console.error("rabbit-hole-proxy: article_view event insert failed", eventError);
  } catch (e) {
    console.error("rabbit-hole-proxy: logArticleViewEvent failed", e);
  }
}

// Verifies a client-supplied access token (never trust a client-supplied
// user id directly) and looks up whether that account is funded, plus its
// feature-toggle preferences (production punch list, Section C). Returns
// { userId: null, funded: false, featureDigDeeper: false } for an
// anonymous caller or an invalid/expired token — fails open into
// "anonymous," not into "funded," so a broken token can never accidentally
// grant unlimited access.
async function resolveIdentity(userAccessToken: string | undefined) {
  if (!userAccessToken) return { userId: null as string | null, funded: false, featureDigDeeper: false };
  try {
    const { data, error } = await supabase.auth.getUser(userAccessToken);
    if (error || !data?.user) return { userId: null, funded: false, featureDigDeeper: false };
    const userId = data.user.id;
    const { data: profile } = await supabase
      .from("profiles")
      .select("balance_usd, feature_dig_deeper")
      .eq("id", userId)
      .maybeSingle();
    const funded = !!profile && Number(profile.balance_usd) > 0;
    return { userId, funded, featureDigDeeper: !!profile?.feature_dig_deeper };
  } catch (e) {
    console.error("rabbit-hole-proxy: failed to resolve identity, treating as anonymous", e);
    return { userId: null, funded: false, featureDigDeeper: false };
  }
}

// Fallback when a request doesn't carry a usable client timezone (older
// browser, or the field is missing/malformed) — keeps the trial-day
// cutoff well-defined instead of erroring the request over it.
const DEFAULT_TIME_ZONE = "America/New_York";

// Whether Intl actually recognizes a string as a real IANA timezone name
// — the cheapest way to validate a client-supplied value without a
// hardcoded allowlist of ~400 zone names. Never trust it beyond that:
// see the top-of-file note on why a spoofed timezone here is an accepted
// risk, not something this guards against.
function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// A given timezone's UTC offset in minutes (negative west of Greenwich)
// at a specific instant, DST-aware — read straight from ICU via
// Intl.DateTimeFormat rather than hardcoding offsets, so this stays
// correct across DST transitions for any zone without a timezone library.
function offsetMinutesAt(timeZone: string, utcMs: number): number {
  const part =
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(new Date(utcMs))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const m = part.match(/GMT([+-]\d+)(?::(\d+))?/);
  const hours = m ? parseInt(m[1], 10) : 0;
  const minutes = m?.[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

// Converts a wall-clock date/hour as experienced in the given timezone
// into the real UTC instant it corresponds to. Two-pass correction: the
// first guess treats the wall time as UTC to get a rough instant, then
// re-reads that zone's actual offset at that instant and corrects —
// enough to land exactly right even right around a DST transition.
function wallTimeToUtcMs(timeZone: string, year: number, month: number, day: number, hour: number): number {
  let ms = Date.UTC(year, month - 1, day, hour, 0, 0);
  for (let i = 0; i < 2; i++) {
    ms = Date.UTC(year, month - 1, day, hour, 0, 0) - offsetMinutesAt(timeZone, ms) * 60 * 1000;
  }
  return ms;
}

// Start of the current free-trial day: the most recent 3:00 AM boundary,
// in the GIVEN timezone, at or before `now` — a hard overnight reset
// rather than a rolling window (see the top-of-file note on why, and on
// why this is per-visitor-timezone rather than one fixed zone).
function trialDayStartIso(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");

  let boundaryMs = wallTimeToUtcMs(timeZone, year, month, day, 3);
  if (now.getTime() < boundaryMs) {
    // Still before today's 3am cutoff — the current trial day actually
    // started yesterday at 3am.
    const prev = new Date(Date.UTC(year, month - 1, day - 1));
    boundaryMs = wallTimeToUtcMs(timeZone, prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 3);
  }
  return new Date(boundaryMs).toISOString();
}

// The one cache read for a request, keyed the same way as the serving
// branches in serve() — fetched up front so the free-limit check knows
// whether this page is already cached. A failed lookup falls through to a
// real generation, same fail-open posture as before.
function cacheLookup(endpoint: string, nodeCacheKey?: string, newsCacheKey?: string) {
  if (nodeCacheKey && endpoint === "article") {
    return supabase.from("node_cache").select("article, article_input_tokens, article_output_tokens").eq("cache_key", nodeCacheKey).maybeSingle();
  }
  if (nodeCacheKey && endpoint === "expand") {
    return supabase.from("node_cache").select("children, children_input_tokens, children_output_tokens").eq("cache_key", nodeCacheKey).maybeSingle();
  }
  if (newsCacheKey && endpoint === "expand") {
    return supabase.from("news_root_cache").select("children, root_input_tokens, root_output_tokens").eq("cache_key", newsCacheKey).maybeSingle();
  }
  if (newsCacheKey && endpoint === "article") {
    return supabase
      .from("news_root_cache")
      .select("root_label, article, article_input_tokens, article_output_tokens")
      .eq("cache_key", newsCacheKey)
      .maybeSingle();
  }
  if (newsCacheKey) {
    return supabase
      .from("news_root_cache")
      .select("root_label, overview, children, root_input_tokens, root_output_tokens")
      .eq("cache_key", newsCacheKey)
      .maybeSingle();
  }
  return Promise.resolve(null);
}

// deno-lint-ignore no-explicit-any
function isServableCacheHit(endpoint: string, nodeCacheKey: string | undefined, newsCacheKey: string | undefined, cached: any) {
  if (!cached) return false;
  if (nodeCacheKey && endpoint === "article") return !!cached.article;
  if (nodeCacheKey && endpoint === "expand") return !!cached.children;
  if (newsCacheKey && endpoint === "expand") return Array.isArray(cached.children) && cached.children.length > 0;
  if (newsCacheKey && endpoint === "article") return !!cached.article;
  return endpoint === "root" && !!newsCacheKey;
}

// How many "root" (Dig In) calls this identity has made since the current
// trial day's 3am cutoff in their own timezone — the free-trial search
// count from Section 14.1. Signed-in callers count against their real
// account; anonymous callers still count against their session_id (see
// the top-of-file note on why that stays loose on purpose).
async function countSearches(userId: string | null, sessionId: string, timeZone: string) {
  const since = trialDayStartIso(timeZone);
  let query = supabase
    .from("rabbit_hole_request_logs")
    .select("*", { count: "exact", head: true })
    .eq("endpoint", "article")
    .gte("created_at", since);
  // Cached pages count like any other — readers can't tell them apart.
  query = userId ? query.eq("user_id", userId) : query.eq("session_id", sessionId || "unknown");
  const { count, error } = await query;
  if (error) {
    console.error("rabbit-hole-proxy: search count check failed, allowing request", error);
    return null; // fail open, same posture as the daily-limit check below
  }
  return count ?? 0;
}

// Response shape mimics Anthropic's actual non-streaming response just
// enough for the client's existing callClaude() parsing to work unchanged
// (it reads content[].text and JSON.parses it) — the client has no idea
// whether a given root call was served from cache or freshly generated.
function newsRootCacheResponse(
  row: { root_label: string; overview: string; children: unknown },
  headers: Record<string, string>
) {
  const text = JSON.stringify({ rootLabel: row.root_label, overview: row.overview, children: row.children });
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text }],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
    { status: 200, headers: { ...headers, "Content-Type": "application/json" } }
  );
}

// Same synthetic-response trick as newsRootCacheResponse, but for a cached
// branch's own children (see the nodeCacheKey/"expand" read path below) —
// `content[].text` is a JSON blob with just `children`, matching what a
// real "expand" call's response shape looks like from the client's own
// callClaude() parsing (it only ever reads `data.children` for this
// endpoint).
function nodeChildrenCacheResponse(children: unknown, headers: Record<string, string>) {
  const text = JSON.stringify({ children });
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text }],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
    { status: 200, headers: { ...headers, "Content-Type": "application/json" } }
  );
}

// Same synthetic-response trick as newsRootCacheResponse, but for a cached
// article — plain prose instead of a JSON blob, since streamRaw's cache-hit
// path (src/lib/api.js) just extracts `content[].text` verbatim regardless
// of endpoint. Reused as-is for a branch's own cached article (nodeCacheKey)
// — the response shape is identical either way.
function newsArticleCacheResponse(articleText: string, headers: Record<string, string>) {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: articleText }],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
    { status: 200, headers: { ...headers, "Content-Type": "application/json" } }
  );
}

// Handles `newsCacheWrite` requests — sent by the client after it has
// generated a news/today topic page's chips. This is a client-writable
// path (unlike the rest of this table, which the client can only read), so
// it's deliberately narrow: a new row's cacheKey must match a topic
// generate-trending-topics actually produced, and only the very first
// write for a given key's chips ever takes — nobody can overwrite an
// already-cached topic's content, only race to be first on a brand-new
// one. Accepted trade-off for this app's scale/stakes rather than building
// real request signing for a shared, non-sensitive content cache.
async function handleNewsCacheWrite(write: any, corsHeaders: Record<string, string>) {
  const cacheKey = typeof write?.cacheKey === "string" ? write.cacheKey.trim() : "";
  const rootLabel = typeof write?.rootLabel === "string" ? write.rootLabel : "";
  const overview = typeof write?.overview === "string" ? write.overview : "";
  const children = Array.isArray(write?.children) ? write.children : null;
  // Client-captured real usage for the call that produced these chips —
  // trusted the same way as before (see handleNodeCacheWrite): worst case
  // a single topic's later cache hits get under-billed.
  const inputTokens = Number.isFinite(write?.inputTokens) ? write.inputTokens : null;
  const outputTokens = Number.isFinite(write?.outputTokens) ? write.outputTokens : null;

  if (!cacheKey || !children || children.length === 0) {
    return new Response(JSON.stringify({ error: "invalid newsCacheWrite payload" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Topic pages now cache their article first (see
    // handleNewsArticleCacheWrite, which may create the row with no chips
    // yet) and their chips second, so this fills in a row's still-empty
    // chips rather than only ever inserting. First write still wins: chips
    // already on a row are never overwritten.
    const { data: existing } = await supabase.from("news_root_cache").select("children").eq("cache_key", cacheKey).maybeSingle();
    if (existing) {
      if (!Array.isArray(existing.children) || existing.children.length === 0) {
        await supabase
          .from("news_root_cache")
          .update({ children, root_input_tokens: inputTokens, root_output_tokens: outputTokens })
          .eq("cache_key", cacheKey);
      }
    } else if (await isRealTrendingTopic(cacheKey)) {
      await supabase.from("news_root_cache").upsert(
        {
          cache_key: cacheKey,
          root_label: rootLabel || cacheKey,
          overview,
          children,
          root_input_tokens: inputTokens,
          root_output_tokens: outputTokens,
        },
        { onConflict: "cache_key", ignoreDuplicates: true }
      );
    }
  } catch (e) {
    // best-effort — a failed write just means the next visitor generates
    // fresh too, never worth surfacing as an error to the client over
    console.error("rabbit-hole-proxy: failed to write news root cache", e);
  }

  // Always 200 regardless of outcome — this is a fire-and-forget cache
  // hint from the client's perspective, never something worth retrying or
  // erroring the UI over.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Handles `newsArticleCacheWrite` — sent by the client after it has
// finished streaming a topic page's own article (never a child's; those go
// through handleNodeArticleCacheWrite). The article now streams BEFORE the
// topic's chips exist, so this is usually the write that creates the row:
// title from the client (the article's own "TITLE:" line), no overview,
// chips filled in later by handleNewsCacheWrite. If the row already exists
// (older topics, or a chips write that landed first), it only fills in a
// still-empty article — first write wins either way.
async function handleNewsArticleCacheWrite(write: any, corsHeaders: Record<string, string>) {
  const cacheKey = typeof write?.cacheKey === "string" ? write.cacheKey.trim() : "";
  const article = typeof write?.article === "string" ? write.article : "";
  const rootLabel = typeof write?.rootLabel === "string" ? write.rootLabel.trim() : "";
  const inputTokens = Number.isFinite(write?.inputTokens) ? write.inputTokens : null;
  const outputTokens = Number.isFinite(write?.outputTokens) ? write.outputTokens : null;

  if (!cacheKey || !article) {
    return new Response(JSON.stringify({ error: "invalid newsArticleCacheWrite payload" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { data: existing } = await supabase.from("news_root_cache").select("article").eq("cache_key", cacheKey).maybeSingle();
    if (existing) {
      if (existing.article == null) {
        await supabase
          .from("news_root_cache")
          .update({
            article,
            ...(inputTokens != null ? { article_input_tokens: inputTokens } : {}),
            ...(outputTokens != null ? { article_output_tokens: outputTokens } : {}),
          })
          .eq("cache_key", cacheKey)
          .is("article", null);
      }
    } else if (await isRealTrendingTopic(cacheKey)) {
      await supabase.from("news_root_cache").upsert(
        {
          cache_key: cacheKey,
          root_label: rootLabel || cacheKey,
          overview: "",
          children: [],
          article,
          article_input_tokens: inputTokens,
          article_output_tokens: outputTokens,
        },
        { onConflict: "cache_key", ignoreDuplicates: true }
      );
    }
  } catch (e) {
    console.error("rabbit-hole-proxy: failed to write news article cache", e);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// One level deeper than the news_root_cache functions above — see
// migration 0036_node_cache.sql. A "node" here is a direct child of an
// already-cached root (never a grandchild — see that migration's note on
// why this stays exactly one level deep), keyed by
// "<root's cache_key>::<child label>".
function parseNodeCacheKey(cacheKey: string): { rootCacheKey: string; childLabel: string } | null {
  const idx = cacheKey.indexOf("::");
  if (idx === -1) return null;
  const rootCacheKey = cacheKey.slice(0, idx);
  const childLabel = cacheKey.slice(idx + 2);
  return rootCacheKey && childLabel ? { rootCacheKey, childLabel } : null;
}

// Anti-poisoning check shared by both node_cache write handlers below —
// same posture as handleNewsCacheWrite's trending_topics_cache check, one
// level deeper: a client can only ever cache a (root, child) pairing where
// the root is itself a real cached root AND the child label is one this
// root's own cached generation actually produced, never an arbitrary label.
//
// A child can also be one of the root article's own inline [[links]] (the
// client title-cases the bracketed phrase into the label, so this compares
// case-insensitively with whitespace collapsed).
async function verifyRootChildPair(rootCacheKey: string, childLabel: string): Promise<boolean> {
  const { data: rootRow } = await supabase
    .from("news_root_cache")
    .select("children, article")
    .eq("cache_key", rootCacheKey)
    .maybeSingle();
  const rootChildren = Array.isArray(rootRow?.children) ? rootRow.children : [];
  if (rootChildren.some((c: any) => typeof c?.label === "string" && c.label === childLabel)) return true;
  const wanted = childLabel.trim().replace(/\s+/g, " ").toLowerCase();
  const article = typeof rootRow?.article === "string" ? rootRow.article : "";
  return [...article.matchAll(/\[\[([^[\]]+?)\]\]/g)].some((m) => m[1].trim().replace(/\s+/g, " ").toLowerCase() === wanted);
}

// Same anti-poisoning rule as handleNewsCacheWrite always had: a client can
// only create a cache row for a topic generate-trending-topics actually
// produced, never an arbitrary string.
async function isRealTrendingTopic(cacheKey: string): Promise<boolean> {
  const { data } = await supabase.from("trending_topics_cache").select("topic").eq("topic", cacheKey).limit(1).maybeSingle();
  return !!data;
}

// Handles `nodeCacheWrite` — the branch-level equivalent of
// handleNewsCacheWrite, sent by the client after it has already generated
// (via the non-streaming "expand" endpoint) a branch's own children. Uses a
// plain insert (cache_key is the table's primary key) rather than an
// upsert: a genuine race between two visitors expanding the same brand-new
// branch at once just means the loser's insert fails on the primary key
// conflict, which is caught and swallowed below — same "first write wins,
// no real request signing" trade-off as the root cache.
async function handleNodeCacheWrite(write: any, corsHeaders: Record<string, string>) {
  const cacheKey = typeof write?.cacheKey === "string" ? write.cacheKey.trim() : "";
  const children = Array.isArray(write?.children) ? write.children : null;
  const inputTokens = Number.isFinite(write?.inputTokens) ? write.inputTokens : null;
  const outputTokens = Number.isFinite(write?.outputTokens) ? write.outputTokens : null;
  const parsed = cacheKey ? parseNodeCacheKey(cacheKey) : null;

  if (!parsed || !children) {
    return new Response(JSON.stringify({ error: "invalid nodeCacheWrite payload" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    if (await verifyRootChildPair(parsed.rootCacheKey, parsed.childLabel)) {
      const { data: existing } = await supabase.from("node_cache").select("children").eq("cache_key", cacheKey).maybeSingle();
      if (!existing) {
        await supabase.from("node_cache").insert({
          cache_key: cacheKey,
          root_cache_key: parsed.rootCacheKey,
          child_label: parsed.childLabel,
          children,
          children_input_tokens: inputTokens,
          children_output_tokens: outputTokens,
        });
      } else if (existing.children == null) {
        // Row already exists (its article was cached first, independently
        // — see handleNodeArticleCacheWrite) but children never were.
        await supabase
          .from("node_cache")
          .update({ children, children_input_tokens: inputTokens, children_output_tokens: outputTokens })
          .eq("cache_key", cacheKey)
          .is("children", null);
      }
    }
  } catch (e) {
    // best-effort — a failed write just means the next visitor generates
    // fresh too, never worth surfacing as an error to the client over
    console.error("rabbit-hole-proxy: failed to write node cache", e);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Handles `nodeArticleCacheWrite` — the branch-level equivalent of
// handleNewsArticleCacheWrite. Unlike that function, the row here may not
// exist yet (a visitor can open a branch's article without ever expanding
// it further), so this creates the row itself when needed rather than
// assuming handleNodeCacheWrite already ran first — and, since that means
// there's no guaranteed-already-existing row for a later server-side update
// to attach usage to, the client passes its own captured usage in THIS same
// write (see api.js's writeNodeArticleCache), same reasoning as
// writeNewsRootCache's usage args.
async function handleNodeArticleCacheWrite(write: any, corsHeaders: Record<string, string>) {
  const cacheKey = typeof write?.cacheKey === "string" ? write.cacheKey.trim() : "";
  const article = typeof write?.article === "string" ? write.article : "";
  const inputTokens = Number.isFinite(write?.inputTokens) ? write.inputTokens : null;
  const outputTokens = Number.isFinite(write?.outputTokens) ? write.outputTokens : null;
  const parsed = cacheKey ? parseNodeCacheKey(cacheKey) : null;

  if (!parsed || !article) {
    return new Response(JSON.stringify({ error: "invalid nodeArticleCacheWrite payload" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { data: existing } = await supabase.from("node_cache").select("article").eq("cache_key", cacheKey).maybeSingle();
    if (!existing) {
      if (await verifyRootChildPair(parsed.rootCacheKey, parsed.childLabel)) {
        await supabase.from("node_cache").insert({
          cache_key: cacheKey,
          root_cache_key: parsed.rootCacheKey,
          child_label: parsed.childLabel,
          article,
          article_input_tokens: inputTokens,
          article_output_tokens: outputTokens,
        });
      }
    } else if (existing.article == null) {
      await supabase
        .from("node_cache")
        .update({ article, article_input_tokens: inputTokens, article_output_tokens: outputTokens })
        .eq("cache_key", cacheKey)
        .is("article", null);
    }
  } catch (e) {
    console.error("rabbit-hole-proxy: failed to write node article cache", e);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // Handled before anything else — no Anthropic call happens on this
    // path at all, so it needs neither the API key nor the messages/limit
    // checks below.
    if (body.newsCacheWrite) {
      return handleNewsCacheWrite(body.newsCacheWrite, corsHeaders);
    }
    if (body.newsArticleCacheWrite) {
      return handleNewsArticleCacheWrite(body.newsArticleCacheWrite, corsHeaders);
    }
    if (body.nodeCacheWrite) {
      return handleNodeCacheWrite(body.nodeCacheWrite, corsHeaders);
    }
    if (body.nodeArticleCacheWrite) {
      return handleNodeArticleCacheWrite(body.nodeArticleCacheWrite, corsHeaders);
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY secret is not set on this function" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const {
      messages,
      max_tokens,
      stream,
      endpoint,
      sessionId,
      system,
      newsCacheKey,
      nodeCacheKey,
      userAccessToken,
      nodeType,
      timeZone,
      heroSource,
      utmSource,
      utmCampaign,
      utmContent,
      rdtCid,
      visitorId,
      visitorSessionId,
      isTest,
      modelOverride,
    } = body;
    const effectiveTimeZone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;

    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const clientIp = getClientIp(req);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Preflight round 1: identity plus both rate-limit counts, run
    // concurrently — none of the three depends on either of the others'
    // result. This used to be three sequential awaits (identity, THEN
    // session count, THEN IP count), each a real Supabase round-trip added
    // to every single request's time-to-first-byte before generation even
    // starts — real, felt latency, especially galling on a cache hit that's
    // otherwise near-instant. Same checks, same precedence (session limit
    // still wins over IP limit if both would fire), just fetched together
    // instead of one after another.
    const [identity, sessionCountResult, ipCountResult] = await Promise.all([
      resolveIdentity(userAccessToken),
      supabase
        .from("rabbit_hole_request_logs")
        .select("*", { count: "exact", head: true })
        .eq("session_id", sessionId || "unknown")
        .gte("created_at", since),
      clientIp
        ? supabase
            .from("rabbit_hole_request_logs")
            .select("*", { count: "exact", head: true })
            .eq("ip_address", clientIp)
            .gte("created_at", since)
        : Promise.resolve({ count: null as number | null, error: null as Error | null }),
    ]);
    const { userId, funded, featureDigDeeper } = identity;
    // The operator's Tone Lab (/admin) compares models on the same prompt.
    // Only an ADMIN_USER_IDS account can pick the model, and only from this
    // fixed list; everyone else always gets the configured MODEL.
    const isAdmin = !!userId && ADMIN_USER_IDS.has(userId);
    const effectiveModel =
      isAdmin && typeof modelOverride === "string" && TONE_LAB_MODELS.has(modelOverride)
        ? modelOverride
        : endpoint === "root"
          ? ROOT_MODEL
          : MODEL;
    const { count, error: countError } = sessionCountResult;
    const { count: ipCount, error: ipCountError } = ipCountResult;

    if (countError) {
      // fail open — a logging/count hiccup shouldn't block a real request
      console.error("rabbit-hole-proxy: usage count check failed, allowing request", countError);
    } else if ((count ?? 0) >= DAILY_REQUEST_LIMIT) {
      return new Response(
        "Daily limit reached for this browser — try again tomorrow. (This app runs on a shared demo key with a safety cap to prevent runaway costs.)",
        { status: 429, headers: { ...corsHeaders, ...usageHeaders(count), "Content-Type": "text/plain" } }
      );
    }

    // Same ceiling, keyed on IP instead of session_id — see the top-of-file
    // note on why a public launch needs a harder-to-reset identity backing
    // this up. Skipped entirely when the platform hands back no IP at all
    // (fail open, same posture as the session check's countError branch)
    // rather than grouping every such request under one fake "unknown" IP,
    // which would let one blocked bucket lock out everyone else with a
    // missing header.
    if (clientIp) {
      if (ipCountError) {
        console.error("rabbit-hole-proxy: IP usage count check failed, allowing request", ipCountError);
      } else if ((ipCount ?? 0) >= DAILY_REQUEST_LIMIT_PER_IP) {
        return new Response(
          "Daily limit reached for this network — try again tomorrow. (This app runs on a shared demo key with a safety cap to prevent runaway costs.)",
          { status: 429, headers: { ...corsHeaders, ...usageHeaders(count), "Content-Type": "text/plain" } }
        );
      }
    }

    // Preflight round 2: the global spend check and the free-trial search
    // count (see the top-of-file note — computed for every request, not
    // just gated ones, so every response can carry real trial-status
    // headers) both need round 1's `funded`/`userId`, but not each other's
    // result, so these two also run concurrently rather than sequentially
    // — the same "batch what's independent" idea one level later, once
    // identity is actually known.
    // The cache lookup runs alongside the other preflight reads; a hit is
    // marked on the request's log row (cache_hit) for analytics, and is
    // billed and counted toward the free limit like a fresh page.
    const [spendResult, searchCount, cacheResult] = await Promise.all([
      !funded
        ? supabase.rpc("get_recent_spend_usd", { since })
        : Promise.resolve({ data: null as number | null, error: null as Error | null }),
      countSearches(userId, sessionId, effectiveTimeZone),
      cacheLookup(endpoint, nodeCacheKey, newsCacheKey),
    ]);
    if (cacheResult?.error) console.error(`rabbit-hole-proxy: ${endpoint} cache lookup failed`, cacheResult.error);
    // deno-lint-ignore no-explicit-any
    const cached: any = cacheResult?.error ? null : cacheResult?.data ?? null;
    const cacheHit = isServableCacheHit(endpoint, nodeCacheKey, newsCacheKey, cached);

    // The real backstop — see the top-of-file note. Total measured spend
    // across ALL free/unfunded traffic, not one session or IP's request
    // count, so many distinct abusers each staying under their own ceiling
    // still can't add up to unbounded real cost. Funded callers are exempt:
    // their own balance already bounds what they can spend.
    if (!funded) {
      const { data: recentSpend, error: spendError } = spendResult;
      if (spendError) {
        // fail open — same posture as every other check here
        console.error("rabbit-hole-proxy: global spend check failed, allowing request", spendError);
      } else if (Number(recentSpend ?? 0) >= GLOBAL_DAILY_SPEND_LIMIT_USD) {
        return new Response(
          JSON.stringify({
            error: "free_tier_paused",
            message: "Free access is temporarily paused for today due to unusually high demand — add funds to keep going, or try again tomorrow.",
          }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // A root topic's OWN auto-loaded "read more" article is exempt from the
    // gate, same as root itself — otherwise a brand new "Dig In" search
    // after the trial's exhausted would generate its title/overview fine
    // and then immediately fail trying to load the body text, looking
    // broken. This is the one article call still allowed past the limit;
    // every other article (a child reached via a link/chip) and every
    // expand/continuation call stays gated, so there's still no way to
    // branch or "dig deeper" for free once exhausted — just always a full
    // standalone page for whatever was just typed in.
    const isRootArticle = endpoint === "article" && nodeType === "root";
    const searchLimit = searchLimitFor(userId);
    const trialBlocked =
      !funded &&
      !isAdmin &&
      searchCount !== null &&
      searchCount >= searchLimit &&
      GATED_ENDPOINTS.has(endpoint) &&
      !isRootArticle;
    // +1 only when THIS call is itself an "article" call that's actually
    // going to be allowed through — countSearches queried
    // rabbit_hole_request_logs before logRequest() below inserts this
    // request's own row, so a fresh page's own article call never counted
    // itself, showing one less than reality until the next call caught
    // up. A BLOCKED article call never gets logged at all (it's rejected
    // below before ever reaching Anthropic), so it must not get this +1
    // either — that bug briefly showed counts like "7/6", climbing by one
    // on every retry after the trial was already exhausted, since each
    // rejected retry still claimed credit for a call that never happened.
    // A root article allowed through past the limit legitimately can push
    // the displayed count above the limit (e.g. 7/6) — that's real, not a
    // bug, since it's the one call that's always allowed to go through.
    const displaySearchCount = (searchCount ?? 0) + (!trialBlocked && endpoint === "article" ? 1 : 0);
    const responseHeaders = { ...corsHeaders, ...usageHeaders(count), ...trialHeaders(displaySearchCount, funded, searchLimit) };

    if (trialBlocked) {
      return new Response(
        JSON.stringify({
          error: "trial_exhausted",
          message: userId
            ? `Free pages used up for today (${searchLimit}) — resets at 3am your time. Add funds for full access.`
            : `Free pages used up for today (${searchLimit}) — resets at 3am your time. Sign up free for more.`,
        }),
        { status: 402, headers: { ...responseHeaders, "Content-Type": "application/json" } }
      );
    }

    // Section C's feature toggles (à la carte, funded accounts only): the
    // client already hides the "Dig deeper" button when this is off, so a
    // normal client never reaches this — this is defense-in-depth against
    // a hand-crafted request, not the primary enforcement mechanism (which
    // is UI-level, since a funded caller only ever spends their own
    // balance either way). News/Today have no server-side equivalent —
    // both are just regular "root" calls indistinguishable from a
    // manually-typed Dig In search, and root is never gated by design.
    if (funded && endpoint === "continuation" && !featureDigDeeper) {
      return new Response(
        JSON.stringify({
          error: "feature_disabled",
          message: "Dig Deeper is turned off in your account settings.",
        }),
        { status: 403, headers: { ...responseHeaders, "Content-Type": "application/json" } }
      );
    }

    // fire-and-forget — never block the actual Claude call on this. The
    // returned promise is only awaited later, inside the background
    // billing task below, once the real cost is known.
    const logRowIdPromise = logRequest(sessionId, endpoint, userId, nodeType, clientIp, funded, heroSource, {
      utmSource,
      utmCampaign,
      rdtCid,
    }, cacheHit, !!isTest);

    // Adoption analytics (see logArticleViewEvent above) — only an
    // "article" call counts as an article_view; root/expand/continuation
    // calls aren't page views. Fire-and-forget, same as logRequest.
    if (endpoint === "article") {
      logArticleViewEvent(visitorId, visitorSessionId, newsCacheKey || nodeCacheKey || heroSource || null, userId, !!isTest, {
        utmSource,
        utmCampaign,
        utmContent,
      });
    }

    if (nodeCacheKey && endpoint === "article") {
      // Branch-level equivalent of the newsCacheKey/"article" branch below
      // — see migration 0036_node_cache.sql. Same billing posture: a cache
      // hit here is billed the same as the original real generation.
      if (cacheHit) {
        if (cached.article_input_tokens != null || cached.article_output_tokens != null) {
          background(
            billAndLog(
              { input_tokens: cached.article_input_tokens ?? 0, output_tokens: cached.article_output_tokens ?? 0 },
              logRowIdPromise,
              userId,
              0
            )
          );
        }
        return newsArticleCacheResponse(cached.article, responseHeaders);
      }
    } else if (nodeCacheKey && endpoint === "expand") {
      // Branch-level equivalent of the newsCacheKey root branch below, for
      // a branch's own "dig deeper" children instead of a root's. Response
      // shape only needs `children` (see App.jsx's expandNode, which reads
      // `data.children` and never `data.rootLabel`/`data.overview` for this
      // endpoint) — the client's callClaude() JSON-parses this the same as
      // any other "expand" response, unaware it came from cache.
      if (cacheHit) {
        if (cached.children_input_tokens != null || cached.children_output_tokens != null) {
          background(
            billAndLog(
              { input_tokens: cached.children_input_tokens ?? 0, output_tokens: cached.children_output_tokens ?? 0 },
              logRowIdPromise,
              userId,
              0
            )
          );
        }
        return nodeChildrenCacheResponse(cached.children, responseHeaders);
      }
    } else if (newsCacheKey && endpoint === "expand") {
      // A cached topic's own chips. Topic pages no longer make a "root"
      // call — the article streams first and the chips are generated
      // afterwards as an "expand" call, cached on the same row. An empty
      // array means only the article has been cached so far.
      if (cacheHit) {
        if (cached.root_input_tokens != null || cached.root_output_tokens != null) {
          background(
            billAndLog(
              { input_tokens: cached.root_input_tokens ?? 0, output_tokens: cached.root_output_tokens ?? 0 },
              logRowIdPromise,
              userId,
              0
            )
          );
        }
        return nodeChildrenCacheResponse(cached.children, responseHeaders);
      }
    } else if (newsCacheKey && endpoint === "article") {
      if (cacheHit) {
        // Bills this cache hit the SAME as the original real generation —
        // most traffic starts from the hero page, so serving every reader
        // after the first one for free would give away real revenue.
        // Backgrounded like the real-generation billing path below rather
        // than awaited, so a cache hit still returns instantly; usage may
        // be null for a row cached before this billing existed, in which
        // case this is a no-op and the read stays free (rare — this table
        // was effectively empty of cached articles when this shipped).
        if (cached.article_input_tokens != null || cached.article_output_tokens != null) {
          background(
            billAndLog(
              { input_tokens: cached.article_input_tokens ?? 0, output_tokens: cached.article_output_tokens ?? 0 },
              logRowIdPromise,
              userId,
              0
            )
          );
        }
        // The client reads a topic page's display title from the article's
        // first line. Rows cached before that format don't have one, so it
        // gets added here from the row's stored title.
        const article = cached.article.startsWith("TITLE:") || !cached.root_label
          ? cached.article
          : `TITLE: ${cached.root_label}\n\n${cached.article}`;
        return newsArticleCacheResponse(article, responseHeaders);
      }
    } else if (newsCacheKey) {
      if (cacheHit) {
        // Same reasoning as the article cache hit above — bills this read
        // the same as the original generation instead of giving it away.
        // root_input_tokens/output_tokens come from the CLIENT's own
        // cache-write (see writeNewsRootCache) rather than a server-side
        // background update, since this row is created by that same write
        // — nothing to race against here.
        if (cached.root_input_tokens != null || cached.root_output_tokens != null) {
          background(
            billAndLog(
              { input_tokens: cached.root_input_tokens ?? 0, output_tokens: cached.root_output_tokens ?? 0 },
              logRowIdPromise,
              userId,
              0
            )
          );
        }
        return newsRootCacheResponse(cached, responseHeaders);
      }
    }

    const anthropicCallStartedAt = Date.now();
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: effectiveModel,
        max_tokens: max_tokens || 1200,
        stream: !!stream,
        // claude-sonnet-5 (and Haiku 5.5) run adaptive thinking by default;
        // left enabled, thinking tokens can consume the whole max_tokens
        // budget before any actual output is written (empty response,
        // broken JSON parsing client-side). This app has no need for
        // reasoning depth. Haiku 4.5 doesn't think unless asked, so it gets
        // no thinking field at all.
        ...(effectiveModel.startsWith("claude-haiku-4-5") ? {} : { thinking: { type: "disabled" } }),
        // Optional prompt-caching support: the client builds the full
        // Anthropic `system` array itself (text + cache_control), this just
        // forwards it through untouched — no logic here needs to know
        // anything about caching. Omitted entirely when the client doesn't
        // send one, so this stays a no-op for any older/other caller.
        ...(system ? { system: withVoiceReference(system, effectiveModel) } : {}),
        messages: withArticleExamples(messages, effectiveModel, endpoint),
      }),
    });

    // Billing (Section D): clone() tees the underlying body into two
    // independent readers *before* anything below touches either one —
    // the clone read in the background for cost/billing purposes can
    // never delay, truncate, or otherwise affect the original response
    // streamed back to the client immediately after. This is the only
    // change billing makes to this path; the client-facing pass-through
    // itself (anthropicRes.body below) is untouched, same as before.
    if (anthropicRes.ok) {
      background(
        extractUsageAndBill(
          anthropicRes.clone(),
          logRowIdPromise,
          userId,
          anthropicCallStartedAt,
          newsCacheKey ? { newsCacheKey, endpoint } : undefined,
          effectiveModel
        )
      );
    }

    // stream the response straight through unmodified — the client's own
    // SSE parsing handles the rest, same as it would talking to Anthropic
    // directly. Headers are separate from the body, so adding one here
    // doesn't touch the streaming pass-through itself.
    return new Response(anthropicRes.body, {
      status: anthropicRes.status,
      headers: {
        ...responseHeaders,
        "Content-Type": anthropicRes.headers.get("Content-Type") || "application/json",
      },
    });
  } catch (e) {
    console.error("rabbit-hole-proxy: unexpected error", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
