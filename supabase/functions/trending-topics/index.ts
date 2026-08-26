// Supabase Edge Function: trending-topics
//
// NOTE: this function is already deployed under the Supabase project as
// "smooth-responder", not "trending-topics" — an artifact of how it was
// first created. Not currently wired into the app (the hero screen's "In
// the news" chips use a static, hand-verified pool instead — see
// TODAYS_TOPICS_POOL in src/App.jsx, and the comment there on why: a
// claude.ai artifact couldn't reach this function at runtime). It's kept
// here, confirmed working, for whenever live headline chips get wired in
// for real in the standalone app; if you redeploy it, keep the existing
// function name and don't rename it back to "trending-topics" without
// updating every place that calls it.
//
// Deploy this as a function named "trending-topics" in your Supabase
// project. It holds the actual SerpApi key server-side (as a Supabase
// secret) and returns just clean, short topic strings — the Rabbit Hole
// app never sees the SerpApi key at all, only this function's output.
//
// DEPLOY STEPS (once you have the Supabase CLI installed and are logged in):
//   1. supabase functions new trending-topics
//   2. Replace the generated index.ts with this file's contents
//   3. Get your SerpApi key from https://serpapi.com/manage-api-key
//   4. supabase secrets set SERPAPI_KEY=your_actual_key_here
//   5. supabase functions deploy trending-topics
//
// After deploying, the function is reachable at:
//   https://gflcioanuzrxgxxafnzl.supabase.co/functions/v1/trending-topics
//
// WHAT'S CONFIRMED VS. STILL A GUESS:
//
//   - CONFIRMED: the top-level response key is "news_results" — this
//     matches `results[:news_results]` from the Ruby example directly, so
//     the outer .map() below should be right.
//
//   - A REAL TRADE-OFF, NOT JUST A GUESS: both examples you found include
//     a "q" (query) parameter, which is a strong signal it's required for
//     this engine — meaning this can't actually be "general top headlines
//     right now," it's "headlines about whatever query we send." QUERY
//     below is set to a broad term to approximate general daily news, but
//     it's inherently narrower than true top-headlines browsing would be.
//     Swap QUERY for whatever feels like a better fit, or see the note
//     further down for rotating through a few broad categories instead if
//     you want more variety across calls (at the cost of more SerpApi
//     usage per app load).
//
//   - STILL UNVERIFIED: the field name for each item's headline text
//     (assumed to be "title" below, which is standard for this kind of
//     result but not something either example actually confirmed). If
//     "topics" comes back with a bunch of empty/undefined-looking strings
//     rather than an empty array, this is the thing to check — add
//     console.log(JSON.stringify(data.news_results[0])) right after the
//     fetch below, redeploy, trigger it once, and look at the Supabase
//     function logs to see the real per-item shape.

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  // tighten this to your actual published-artifact domain once you know it,
  // rather than leaving it wide open indefinitely
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Broad on purpose, to approximate "general news" rather than one narrow
// topic — see the comment block above for why this exists at all.
const QUERY = "world news";

serve(async (req) => {
  // browsers send a CORS preflight OPTIONS request before the real one —
  // this has to be answered directly, not passed through to SerpApi
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("SERPAPI_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "SERPAPI_KEY secret is not set on this function" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = `https://serpapi.com/search.json?engine=google_news&q=${encodeURIComponent(QUERY)}&gl=us&hl=en&api_key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      return new Response(JSON.stringify({ error: `SerpApi returned ${res.status}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const data = await res.json();

    // SerpApi can also return a 200 with an "error" field instead of an
    // HTTP error status (e.g. an invalid key) — worth surfacing distinctly
    // from "the request worked but had zero results" so it's easy to tell
    // the two apart while testing.
    if (data.error) {
      return new Response(JSON.stringify({ error: `SerpApi error: ${data.error}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // News headlines are usually too long/specific to work as a one-tap
    // "starting topic" chip as-is, and often have a publication name
    // tacked on after a dash or pipe. Trim to the lead clause and drop
    // anything that's clearly still too short or too long to read well as
    // a chip once trimmed.
    const topics = (data.news_results || [])
      .map((a) => (a.title || "").split(" - ")[0].split(" | ")[0].trim())
      .filter((t) => t.length > 8 && t.length < 90)
      .slice(0, 6);

    return new Response(JSON.stringify({ topics }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
