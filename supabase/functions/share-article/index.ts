// Supabase Edge Function: share-article
//
// Word-of-mouth growth tool — the "Share" button on an article snapshots
// its content here so it can be sent to someone who's never used Hypha.
// No sign-in required to create or read a share: word of mouth from
// people still on the free tier is exactly the audience this is for.
//
// DEPLOY STEPS:
//   1. supabase functions new share-article
//   2. Replace the generated index.ts with this file's contents
//   3. supabase functions deploy share-article
//   (no new secrets — reuses SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY,
//   already set for the other functions in this project)

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://hyfa-x.vercel.app";

// Same CORS-lockdown pattern as the other functions (production punch
// list, Section J) — echoes the request's Origin back only when it's in
// this allowlist, instead of a wide-open "*".
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
  };
}

const VALID_NODE_TYPES = new Set(["root", "direct", "indirect", "tangent", "custom"]);

// Generous but bounded — long enough for any real article this app
// generates, capped so this can't become a way to stash arbitrary large
// blobs in the database for free.
const MAX_TOPIC_LABEL_LEN = 200;
const MAX_OVERVIEW_LEN = 4000;
const MAX_ARTICLE_LEN = 20000;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// URL-safe, unguessable id — this is the actual access control (see the
// migration's comment): RLS makes every row publicly readable by id, so
// the id itself has to be too random to enumerate. 14 chars from a
// 62-character alphabet is ~83 bits of entropy, comfortably beyond
// anything worth brute-forcing.
function generateId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let id = "";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const topicLabel = typeof body?.topicLabel === "string" ? body.topicLabel.trim() : "";
    const nodeType = VALID_NODE_TYPES.has(body?.nodeType) ? body.nodeType : "custom";
    const overview = typeof body?.overview === "string" ? body.overview.trim() : "";
    const article = typeof body?.article === "string" ? body.article.trim() : "";

    if (!topicLabel || topicLabel.length > MAX_TOPIC_LABEL_LEN) {
      return new Response(JSON.stringify({ error: "Invalid topicLabel" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!article || article.length > MAX_ARTICLE_LEN) {
      return new Response(JSON.stringify({ error: "Invalid article" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (overview.length > MAX_OVERVIEW_LEN) {
      return new Response(JSON.stringify({ error: "Invalid overview" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const id = generateId();
    const { error } = await supabase.from("shared_articles").insert({
      id,
      topic_label: topicLabel,
      node_type: nodeType,
      overview: overview || null,
      article,
    });
    if (error) throw error;

    return new Response(JSON.stringify({ id, url: `${APP_ORIGIN}/s/${id}` }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("share-article: failed", e);
    return new Response(JSON.stringify({ error: "Couldn't create share link" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
