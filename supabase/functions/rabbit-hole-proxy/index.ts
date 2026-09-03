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
// block a real person's request — and never blocks on session ids that
// aren't in active use, since the cap is per-session, not global.
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
// blocked, and aren't what's being metered. What's gated is the three
// "rich" functions — expand ("explore next"), article ("read more"), and
// continuation ("dig deeper") — once a non-funded identity has made
// FREE_SEARCH_LIMIT root calls in the last 24h. A signed-in user counts
// against their real account (verified via their access token, never a
// client-supplied id); an anonymous visitor still counts against their
// browser's session_id, per Section 14.2's deliberate choice to keep the
// free tier loosely gated rather than hard-walled. A funded account
// (profiles.balance_usd > 0) skips this gate entirely.
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
  Deno.env.get("ALLOWED_ORIGINS") ?? "https://hyfa-x.vercel.app,http://localhost:5173,http://localhost:5183"
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

// Overridable without a redeploy, same pattern as DAILY_REQUEST_LIMIT —
// matches the monetization outline doc's Section 14.1 ("6 searches",
// explicitly flagged there as a placeholder to tune once real behavior
// data exists).
const FREE_SEARCH_LIMIT = Number(Deno.env.get("FREE_SEARCH_LIMIT") ?? "6");

function trialHeaders(searchesUsed: number, funded: boolean) {
  return {
    "X-Trial-Searches-Used": String(searchesUsed),
    "X-Trial-Search-Limit": String(FREE_SEARCH_LIMIT),
    "X-Trial-Funded": funded ? "1" : "0",
  };
}

// Fixed server-side, deliberately not read from the client request — chosen
// over Haiku 4.5 after a real side-by-side comparison, see the handoff
// README. Don't let a client-supplied model override this.
const MODEL = "claude-sonnet-5";

// Same env var names generate-trending-topics uses for its own cost
// calculation — Supabase secrets are project-wide, so one value covers
// both functions. A future Anthropic price change only needs setting once.
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
function computeCostUsd(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}) {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (input / 1_000_000) * INPUT_PRICE_PER_M +
    (output / 1_000_000) * OUTPUT_PRICE_PER_M +
    (cacheWrite / 1_000_000) * INPUT_PRICE_PER_M * CACHE_WRITE_MULTIPLIER +
    (cacheRead / 1_000_000) * INPUT_PRICE_PER_M * CACHE_READ_MULTIPLIER
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
async function extractUsageAndBill(
  meterRes: Response,
  logRowIdPromise: Promise<number | null>,
  userId: string | null
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

    const costUsd = computeCostUsd(usage);

    const rowId = await logRowIdPromise;
    if (rowId != null) {
      const { error } = await supabase
        .from("rabbit_hole_request_logs")
        .update({ model: MODEL, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cost_usd: costUsd })
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
  } catch (e) {
    console.error("rabbit-hole-proxy: usage/billing extraction failed", e);
  }
}

// Per-session-per-day request ceiling — overridable without a redeploy via
// `supabase secrets set DAILY_REQUEST_LIMIT=...`. 300 is generous headroom
// for genuinely heavy single-day use while still catching a runaway loop
// or a link forwarded well past the "friends" scale this key is sized for.
const DAILY_REQUEST_LIMIT = Number(Deno.env.get("DAILY_REQUEST_LIMIT") ?? "300");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Returns the inserted row's id (or null on failure) so the billing step
// below can attach the real cost to this same row once the call finishes —
// callers still fire this off unawaited at request start (before the
// Anthropic call), never blocking on the id; only the later background
// billing task actually awaits the returned promise.
async function logRequest(sessionId: string, endpoint: string, userId: string | null): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from("rabbit_hole_request_logs")
      .insert({
        session_id: sessionId || "unknown",
        endpoint: endpoint || "unknown",
        user_id: userId,
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

// How many "root" (Dig In) calls this identity has made in the last 24h —
// the free-trial search count from Section 14.1. Signed-in callers count
// against their real account; anonymous callers still count against their
// session_id (see the top-of-file note on why that stays loose on purpose).
async function countSearches(userId: string | null, sessionId: string) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let query = supabase
    .from("rabbit_hole_request_logs")
    .select("*", { count: "exact", head: true })
    .eq("endpoint", "root")
    .gte("created_at", since);
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

// Handles `newsCacheWrite` requests — sent by the client after it has
// already streamed and parsed a root response for a news/today topic. This
// is a client-writable path (unlike the rest of this table, which the
// client can only read), so it's deliberately narrow: the cacheKey must
// match a topic generate-trending-topics actually produced, and the
// underlying upsert (ignoreDuplicates: true) means only the very first
// write for a given key ever takes — nobody can overwrite an
// already-cached topic's content, only race to be first on a brand-new
// one. Accepted trade-off for this app's scale/stakes rather than building
// real request signing for a shared, non-sensitive content cache.
async function handleNewsCacheWrite(write: any, corsHeaders: Record<string, string>) {
  const cacheKey = typeof write?.cacheKey === "string" ? write.cacheKey.trim() : "";
  const rootLabel = typeof write?.rootLabel === "string" ? write.rootLabel : "";
  const overview = typeof write?.overview === "string" ? write.overview : "";
  const children = Array.isArray(write?.children) ? write.children : null;

  if (!cacheKey || !rootLabel || !overview || !children) {
    return new Response(JSON.stringify({ error: "invalid newsCacheWrite payload" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { data: realTopic } = await supabase
      .from("trending_topics_cache")
      .select("topic")
      .eq("topic", cacheKey)
      .limit(1)
      .maybeSingle();
    if (realTopic) {
      await supabase.from("news_root_cache").upsert(
        { cache_key: cacheKey, root_label: rootLabel, overview, children },
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

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY secret is not set on this function" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { messages, max_tokens, stream, endpoint, sessionId, system, newsCacheKey, userAccessToken } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { userId, funded, featureDigDeeper } = await resolveIdentity(userAccessToken);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error: countError } = await supabase
      .from("rabbit_hole_request_logs")
      .select("*", { count: "exact", head: true })
      .eq("session_id", sessionId || "unknown")
      .gte("created_at", since);

    if (countError) {
      // fail open — a logging/count hiccup shouldn't block a real request
      console.error("rabbit-hole-proxy: usage count check failed, allowing request", countError);
    } else if ((count ?? 0) >= DAILY_REQUEST_LIMIT) {
      return new Response(
        "Daily limit reached for this browser — try again tomorrow. (This app runs on a shared demo key with a safety cap to prevent runaway costs.)",
        { status: 429, headers: { ...corsHeaders, ...usageHeaders(count), "Content-Type": "text/plain" } }
      );
    }

    // Free-trial search count — see the top-of-file note. Computed for
    // every request (not just gated ones) so every response can carry real
    // trial-status headers, letting the client proactively hide/disable
    // News/Today/Dig Deeper once the trial's used up instead of only
    // finding out from a failed request.
    const searchCount = await countSearches(userId, sessionId);
    const responseHeaders = { ...corsHeaders, ...usageHeaders(count), ...trialHeaders(searchCount ?? 0, funded) };

    if (!funded && searchCount !== null && searchCount >= FREE_SEARCH_LIMIT && GATED_ENDPOINTS.has(endpoint)) {
      return new Response(
        JSON.stringify({
          error: "trial_exhausted",
          message: `Free trial searches used up for today (${FREE_SEARCH_LIMIT}/24h) — Dig In still works, upgrade for full access.`,
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
    const logRowIdPromise = logRequest(sessionId, endpoint, userId);

    if (newsCacheKey) {
      const { data: cached, error: cacheErr } = await supabase
        .from("news_root_cache")
        .select("root_label, overview, children")
        .eq("cache_key", newsCacheKey)
        .maybeSingle();
      if (cacheErr) {
        // fail open — fall through to a real generation rather than block
        console.error("rabbit-hole-proxy: news root cache lookup failed", cacheErr);
      } else if (cached) {
        return newsRootCacheResponse(cached, responseHeaders);
      }
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: max_tokens || 1200,
        stream: !!stream,
        // claude-sonnet-5 runs adaptive thinking by default; left enabled,
        // thinking tokens can consume the whole max_tokens budget before any
        // actual output is written (empty response, broken JSON parsing
        // client-side). This app has no need for reasoning depth.
        thinking: { type: "disabled" },
        // Optional prompt-caching support: the client builds the full
        // Anthropic `system` array itself (text + cache_control), this just
        // forwards it through untouched — no logic here needs to know
        // anything about caching. Omitted entirely when the client doesn't
        // send one, so this stays a no-op for any older/other caller.
        ...(system ? { system } : {}),
        messages,
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
      background(extractUsageAndBill(anthropicRes.clone(), logRowIdPromise, userId));
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
