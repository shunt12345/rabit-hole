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
// DEPLOY STEPS:
//   1. supabase functions new rabbit-hole-proxy
//   2. Replace the generated index.ts with this file's contents
//   3. supabase secrets set ANTHROPIC_API_KEY=your_actual_key_here
//   4. Run the migration in supabase/migrations to create the log table
//   5. supabase functions deploy rabbit-hole-proxy

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  // tighten this to your actual deployed app's domain once you know it,
  // rather than leaving it wide open indefinitely
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // Browsers only expose the CORS safelist headers to JS by default — a
  // custom header is invisible to fetch()'s res.headers.get() client-side
  // without this, even though it's plainly there on the wire.
  "Access-Control-Expose-Headers": "X-Session-Actions-Today",
};

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

// Fixed server-side, deliberately not read from the client request — chosen
// over Haiku 4.5 after a real side-by-side comparison, see the handoff
// README. Don't let a client-supplied model override this.
const MODEL = "claude-sonnet-5";

// Per-session-per-day request ceiling — overridable without a redeploy via
// `supabase secrets set DAILY_REQUEST_LIMIT=...`. 300 is generous headroom
// for genuinely heavy single-day use while still catching a runaway loop
// or a link forwarded well past the "friends" scale this key is sized for.
const DAILY_REQUEST_LIMIT = Number(Deno.env.get("DAILY_REQUEST_LIMIT") ?? "300");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function logRequest(sessionId: string, endpoint: string) {
  try {
    await supabase.from("rabbit_hole_request_logs").insert({
      session_id: sessionId || "unknown",
      endpoint: endpoint || "unknown",
    });
  } catch (e) {
    // logging is a nice-to-have for Phase 2 planning, never worth failing
    // or even delaying a real user's request over
    console.error("rabbit-hole-proxy: failed to log request", e);
  }
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

    const { messages, max_tokens, stream, endpoint, sessionId, system, newsCacheKey } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    // fire-and-forget — never block the actual Claude call on this
    logRequest(sessionId, endpoint);

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
        return newsRootCacheResponse(cached, { ...corsHeaders, ...usageHeaders(count) });
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

    // stream the response straight through unmodified — the client's own
    // SSE parsing handles the rest, same as it would talking to Anthropic
    // directly. Headers are separate from the body, so adding one here
    // doesn't touch the streaming pass-through itself.
    return new Response(anthropicRes.body, {
      status: anthropicRes.status,
      headers: {
        ...corsHeaders,
        ...usageHeaders(count),
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
