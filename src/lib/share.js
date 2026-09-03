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
