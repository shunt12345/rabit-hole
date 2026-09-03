// Word-of-mouth growth tool — turns the article someone's reading into a
// link a friend can open with no sign-in required. See
// supabase/functions/share-article for the server side.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SHARE_URL = `${SUPABASE_URL}/functions/v1/share-article`;

export async function shareArticle({ topicLabel, nodeType, overview, article }) {
  const res = await fetch(SHARE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ topicLabel, nodeType, overview, article }),
  });

  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error("Couldn't create a share link.");
  }
  if (!res.ok || !data.url) {
    throw new Error(data.error || "Couldn't create a share link.");
  }
  return data.url;
}

// Public read of a shared article by id — straight PostgREST, same as the
// rest of the app's non-billing reads (see supabaseClient.js's own note on
// why most calls skip the SDK). RLS on shared_articles allows anyone to
// select by id, so this needs no auth beyond the anon key.
export async function getSharedArticle(id) {
  const url = `${SUPABASE_URL}/rest/v1/shared_articles?id=eq.${encodeURIComponent(id)}&select=topic_label,node_type,overview,article`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error("Couldn't load this article.");
  const rows = await res.json();
  return rows?.[0] ?? null;
}
