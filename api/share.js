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
const APP_ORIGIN = process.env.APP_ORIGIN || "https://hyfax.app";

const TYPE_LABEL = {
  root: "Origin",
  direct: "Direct",
  indirect: "Indirect",
  tangent: "Tangent",
  custom: "Yours",
};

const TYPE_COLOR = {
  root: "#C1552E",
  direct: "#E3A73C",
  indirect: "#7E9471",
  tangent: "#9C6B8C",
  custom: "#6C93A8",
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function truncate(s, n) {
  if (!s) return "Follow any thought as far as it goes.";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function page({ title, description, url, bodyHtml }) {
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
<meta property="og:image" content="${APP_ORIGIN}/icon-512.png" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${APP_ORIGIN}/icon-512.png" />
<link rel="icon" type="image/png" href="/hyfax-favicon.png" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #14100C; font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif; color: #F5EDDC; }
  .wrap { max-width: 680px; margin: 0 auto; padding: 40px 24px 80px; }
  .logo-link { display: block; text-align: center; margin-bottom: 6px; }
  .logo-link img { height: 36px; }
  .tag { text-align: center; font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.25em; text-transform: uppercase; color: #A89478; margin-bottom: 40px; }
  .badge { display: inline-block; font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; margin-bottom: 14px; }
  h1 { font-style: italic; font-size: 2rem; line-height: 1.15; margin: 0 0 16px; color: #F1E6D3; }
  p { font-size: 16px; line-height: 1.7; margin: 16px 0 0; }
  .cta-row { margin-top: 48px; padding-top: 32px; border-top: 1px solid #3A2E20; text-align: center; }
  .cta-row p { color: #A89478; font-size: 14px; margin: 0 0 16px; }
  .cta { display: inline-flex; align-items: center; gap: 6px; background: #E3A73C; color: #14100C; font-weight: 500; font-size: 14px; padding: 12px 20px; border-radius: 999px; text-decoration: none; }
  .notfound { text-align: center; margin-top: 64px; color: #D98A6E; font-size: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <a class="logo-link" href="${APP_ORIGIN}/"><img src="${APP_ORIGIN}/hyfax-logo.png" alt="Hyfax" /></a>
  <div class="tag">always another thread</div>
  ${bodyHtml}
</div>
</body>
</html>`;
}

function notFoundBody() {
  return `<div class="notfound">This link doesn't lead anywhere.</div>
<p style="text-align:center; color:#A89478; font-size:14px;">It may have been mistyped, or no longer exists.</p>
<div class="cta-row"><a class="cta" href="${APP_ORIGIN}/">Dig in yourself</a></div>`;
}

export default async function handler(req, res) {
  const id = typeof req.query?.id === "string" ? req.query.id : "";
  const shareUrl = `${APP_ORIGIN}/s/${id}`;
  const fallback = { title: "Hyfax", description: "Follow any thought as far as it goes.", url: shareUrl, bodyHtml: notFoundBody() };

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
  const badgeColor = TYPE_COLOR[row.node_type] || "#E3A73C";

  const bodyHtml = `
<span class="badge" style="color:${badgeColor}; border:1px solid ${badgeColor}55;">${escapeHtml(TYPE_LABEL[row.node_type] || "Thread")}</span>
<h1>${escapeHtml(row.topic_label)}</h1>
${row.overview ? `<p>${escapeHtml(row.overview)}</p>` : ""}
${paragraphs}
<div class="cta-row">
  <p>Someone shared this with you. Follow your own thought as far as it goes.</p>
  <a class="cta" href="${APP_ORIGIN}/">Dig in yourself</a>
</div>`;

  res.status(200);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=3600");
  res.end(page({ title: `${row.topic_label} · Hyfax`, description, url: shareUrl, bodyHtml }));
}
