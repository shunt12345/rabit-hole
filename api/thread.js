// Vercel serverless function — serves /t/:id (see vercel.json's rewrite), the
// link ChainView's Share button hands out for a Hyfax thread.
//
// Link-preview scrapers don't run JavaScript, so the app's own /?thread=<id>
// would preview as the generic Hyfax banner. This page carries the thread's
// own title and card (api/og.js?thread=<id>, "From A to B" only, never the
// steps) in its markup, and sends a real visitor straight on to the thread
// in the app.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const CANONICAL_ORIGIN = "https://www.hyfax.app";
const DESCRIPTION = "Four steps on one thread. How do you get from one to the other?";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Same split as splitThreadTitle in src/lib/chains.js.
function previewTitle(title) {
  const m = String(title || "").match(/^(.+?)\s+to\s+(.+)$/i);
  return m ? `From ${m[1].trim()} to ${m[2].trim()}` : String(title || "");
}

function page({ title, url, appUrl, image }) {
  const t = escapeHtml(title);
  const u = escapeHtml(url);
  const a = escapeHtml(appUrl);
  const img = escapeHtml(image);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${t} · Hyfax</title>
<meta name="description" content="${escapeHtml(DESCRIPTION)}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="Hyfax" />
<meta property="og:title" content="${t}" />
<meta property="og:description" content="${escapeHtml(DESCRIPTION)}" />
<meta property="og:url" content="${u}" />
<link rel="canonical" href="${u}" />
<meta property="og:image" content="${img}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${t}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${t}" />
<meta name="twitter:description" content="${escapeHtml(DESCRIPTION)}" />
<meta name="twitter:image" content="${img}" />
<meta http-equiv="refresh" content="0; url=${a}" />
<link rel="icon" type="image/png" href="/hyfax-favicon.png" />
<style>body{margin:0;background:#14100C;color:#C9B896;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding-top:30vh}a{color:#E3A73C}</style>
</head>
<body>
<p>Opening the thread… <a href="${a}">tap here</a> if it doesn't open.</p>
<script>location.replace(${JSON.stringify(appUrl).replace(/</g, "\\u003c")});</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  const id = typeof req.query?.id === "string" && /^[0-9]+$/.test(req.query.id) ? req.query.id : "";
  let row = null;
  if (id) {
    try {
      const apiRes = await fetch(`${SUPABASE_URL}/rest/v1/hyfax_chains?id=eq.${id}&select=title`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      });
      if (apiRes.ok) row = (await apiRes.json())?.[0] ?? null;
    } catch (e) {
      console.error("api/thread: fetch failed", e);
    }
  }

  // An unknown thread still lands on the app (the home page).
  const appUrl = row
    ? `${CANONICAL_ORIGIN}/?thread=${id}&utm_source=share&utm_content=thread`
    : `${CANONICAL_ORIGIN}/?utm_source=share&utm_content=thread`;
  res.status(row ? 200 : 404);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", row ? "public, max-age=300, s-maxage=3600" : "public, max-age=60");
  res.end(
    page({
      title: row ? previewTitle(row.title) : "Hyfax: Thinking with threads",
      url: `${CANONICAL_ORIGIN}/t/${id}`,
      appUrl,
      image: row ? `${CANONICAL_ORIGIN}/api/og?thread=${id}` : `${CANONICAL_ORIGIN}/og-image.jpg`,
    })
  );
}
