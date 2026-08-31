// Supabase Edge Function: rabbit-hole-proxy
//
// Holds the real Anthropic API key server-side and is the ONLY thing that
// ever calls api.anthropic.com for this app. The client never sees the key
// and never talks to Anthropic directly — see the handoff README's Phase 1
// plan for why (the old claude.ai-artifact version got auth for free from
// that environment; a standalone deployment has to provide it itself).
//
// Every request is logged (best-effort, non-blocking) to the
// rabbit_hole_request_logs table — timestamp, anonymous session id,
// endpoint label, and real input/output token counts parsed from
// Anthropic's own response — so Phase 2's per-person usage caps (and
// actual cost-per-endpoint, instead of an estimate) can be set from real
// numbers. The client's copy of the response is served off a tee()'d
// branch of the stream so parsing usage never adds latency to the real
// request; the log row is written once that branch finishes, not before.
// Logging failures never block or fail the actual Claude request.
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
};

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

// Pulls real token usage out of Anthropic's response body — works for both
// shapes this proxy ever forwards: a single non-streaming JSON object
// (`stream: false`, has a top-level "usage") and an SSE stream (`stream:
// true`), where input_tokens rides on the `message_start` event and the
// running output_tokens total rides on each `message_delta` event (the
// last one before the stream ends is the final count). Returns nulls
// rather than throwing if the shape doesn't match — this is telemetry, not
// something worth failing a log row over.
function extractUsage(rawText: string): { inputTokens: number | null; outputTokens: number | null } {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return {
        inputTokens: parsed?.usage?.input_tokens ?? null,
        outputTokens: parsed?.usage?.output_tokens ?? null,
      };
    } catch (_) {
      return { inputTokens: null, outputTokens: null };
    }
  }

  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (const line of rawText.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr || jsonStr === "[DONE]") continue;
    let evt: any;
    try {
      evt = JSON.parse(jsonStr);
    } catch (_) {
      continue;
    }
    if (evt.type === "message_start" && evt.message?.usage) {
      inputTokens = evt.message.usage.input_tokens ?? inputTokens;
    } else if (evt.type === "message_delta" && evt.usage) {
      outputTokens = evt.usage.output_tokens ?? outputTokens;
    }
  }
  return { inputTokens, outputTokens };
}

// Reads the logging branch of the tee'd response body to completion, then
// writes one row. Runs detached from the client's own read of the other
// branch — never awaited by the request handler, never able to slow or
// fail the real response.
async function logRequestWithUsage(sessionId: string, endpoint: string, body: ReadableStream<Uint8Array> | null) {
  try {
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    if (body) {
      const rawText = await new Response(body).text();
      ({ inputTokens, outputTokens } = extractUsage(rawText));
    }
    await supabase.from("rabbit_hole_request_logs").insert({
      session_id: sessionId || "unknown",
      endpoint: endpoint || "unknown",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
  } catch (e) {
    // logging is a nice-to-have for Phase 2 planning, never worth failing
    // or even delaying a real user's request over
    console.error("rabbit-hole-proxy: failed to log request", e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY secret is not set on this function" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { messages, max_tokens, stream, endpoint, sessionId } = body;

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
        { status: 429, headers: { ...corsHeaders, "Content-Type": "text/plain" } }
      );
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
        messages,
      }),
    });

    // Two independent copies of the body: one goes straight to the client
    // unmodified (same as before — the client's own SSE parsing handles the
    // rest, same as it would talking to Anthropic directly), the other is
    // read server-side in the background purely to log real token usage.
    // logRequestWithUsage is never awaited — it can't add latency or ever
    // fail the actual response.
    const [clientBody, loggingBody] = anthropicRes.body ? anthropicRes.body.tee() : [null, null];
    logRequestWithUsage(sessionId, endpoint, loggingBody);

    return new Response(clientBody, {
      status: anthropicRes.status,
      headers: {
        ...corsHeaders,
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
