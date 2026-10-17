// Vercel serverless function — serves /s/:id (see vercel.json's rewrite)
// as plain server-rendered HTML instead of the React app.
//
// Two reasons this has to live here instead of in the SPA: link-preview
// scrapers (iMessage, Twitter, Slack, etc.) read whatever HTML this
// endpoint returns without running JavaScript, so the real per-article
// title/description has to already be in the markup on the first
// response — a client-rendered React page would show every shared link
// as the same generic "Hyfax" card. And once that's true anyway, serving
// the same HTML to real visitors means one implementation of this page
// instead of a server-rendered one for bots and a separate React one for
// people, which would drift out of sync with each other over time.
//
// Reuses VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — already set as
// Vercel project env vars for the client build, and just as readable by
// a serverless function at runtime. No new secrets needed.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const APP_ORIGIN = process.env.APP_ORIGIN || "https://www.hyfax.app";
// The address search engines and link previews should treat as the real
// one: hyfax.app redirects here, whatever APP_ORIGIN says.
const CANONICAL_ORIGIN = "https://www.hyfax.app";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Links from a shared page back into the app, tagged so /admin can tell
// shared-link visits apart. With a topic, the app opens that page (with its
// threads) instead of the home page.
const SHARE_UTM = "utm_source=share&utm_medium=link&utm_campaign=shared-article";
function appLink(topic) {
  return `${CANONICAL_ORIGIN}/?${topic ? `topic=${encodeURIComponent(topic)}&` : ""}${SHARE_UTM}`;
}

function truncate(s, n) {
  if (!s) return "Problem solving isn't linear. Neither is your learning. Follow any question across science, food, history and more, one thread at a time.";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function page({ title, description, url, bodyHtml, image = `${CANONICAL_ORIGIN}/og-image.jpg` }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="Hyfax" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(url)}" />
<link rel="canonical" href="${escapeHtml(url)}" />
<meta property="og:image" content="${escapeHtml(image)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(image)}" />
<link rel="icon" type="image/png" href="/hyfax-favicon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@1,600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #14100C; font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif; color: #F1E6D3; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 36px 24px 72px; }
  .logo-link { display: block; text-align: center; margin-bottom: 8px; }
  .logo-link img { height: 52px; }
  .tag { text-align: center; font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.25em; text-transform: uppercase; color: #A89478; margin-bottom: 44px; }
  .kicker { font-family: "JetBrains Mono", monospace; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #E3A73C; margin-bottom: 12px; }
  h1 { font-family: "Fraunces", Georgia, serif; font-style: italic; font-weight: 600; font-size: 2.1rem; line-height: 1.15; margin: 0 0 18px; color: #F1E6D3; }
  .lede { font-size: 17px; line-height: 1.6; color: #C9B896; margin: 0 0 8px; }
  p { font-size: 16px; line-height: 1.75; margin: 16px 0 0; color: #E9DDC8; }
  .cta-row { margin-top: 48px; padding-top: 32px; border-top: 1px solid #3A2E20; text-align: center; }
  .cta-row p { color: #A89478; font-size: 14px; margin: 0 0 18px; }
  .cta { display: inline-flex; align-items: center; gap: 8px; background: #E3A73C; color: #14100C; font-weight: 600; font-size: 15px; padding: 13px 24px; border-radius: 999px; text-decoration: none; }
  .secondary { display: block; margin-top: 16px; color: #C9B896; font-size: 13px; text-decoration: underline; text-underline-offset: 3px; }
  .notfound { text-align: center; margin-top: 64px; color: #D98A6E; font-size: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <a class="logo-link" href="${appLink()}"><img src="${CANONICAL_ORIGIN}/hyfax-logo.png" alt="Hyfax" /></a>
  <div class="tag">thinking with threads</div>
  ${bodyHtml}
</div>
</body>
</html>`;
}

function notFoundBody() {
  return `<div class="notfound">This link doesn't lead anywhere.</div>
<p style="text-align:center; color:#A89478; font-size:14px;">It may have been mistyped, or no longer exists.</p>
<div class="cta-row"><a class="cta" href="${appLink()}">Explore Hyfax</a></div>`;
}

export default async function handler(req, res) {
  const id = typeof req.query?.id === "string" ? req.query.id : "";
  const shareUrl = `${CANONICAL_ORIGIN}/s/${id}`;
  const fallback = { title: "Hyfax", description: "Problem solving isn't linear. Neither is your learning. Follow any question across science, food, history and more, one thread at a time.", url: shareUrl, bodyHtml: notFoundBody() };

  if (!id || !/^[A-Za-z0-9]+$/.test(id)) {
    res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(page(fallback));
    return;
  }

  let row = null;
  try {
    const apiRes = await fetch(
      `${SUPABASE_URL}/rest/v1/shared_articles?id=eq.${encodeURIComponent(id)}&select=topic_label,node_type,overview,article`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (apiRes.ok) {
      const rows = await apiRes.json();
      row = rows?.[0] ?? null;
    }
  } catch (e) {
    console.error("api/share: fetch failed", e);
  }

  if (!row) {
    res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(page(fallback));
    return;
  }

  const description = truncate(row.overview || row.article, 200);
  const paragraphs = String(row.article || "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("\n");
  const bodyHtml = `
<div class="kicker">A Hyfax thread</div>
<h1>${escapeHtml(row.topic_label)}</h1>
${row.overview ? `<p class="lede">${escapeHtml(row.overview)}</p>` : ""}
${paragraphs}
<div class="cta-row">
  <p>Someone shared this with you. Every page on Hyfax opens into more threads.</p>
  <a class="cta" href="${appLink(row.topic_label)}">Keep pulling this thread &rarr;</a>
  <a class="secondary" href="${appLink()}">or see today's picks on Hyfax</a>
</div>`;

  res.status(200);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=3600");
  // This article's own card (api/og.js), so the link shows its title in a feed.
  res.end(page({ title: `${row.topic_label} · Hyfax`, description, url: shareUrl, bodyHtml, image: `${CANONICAL_ORIGIN}/api/og?id=${id}` }));
}
