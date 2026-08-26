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

    // fire-and-forget — never block the actual Claude call on this
    logRequest(sessionId, endpoint);

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
        messages,
      }),
    });

    // stream the response straight through unmodified — the client's own
    // SSE parsing handles the rest, same as it would talking to Anthropic
    // directly
    return new Response(anthropicRes.body, {
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
