// Vercel serverless function — /api/og?id=<share id> draws the link-preview
// card for one shared article (1200x630 PNG): the topic's title and its
// opening line on the Hyfax background, so a shared link shows up in a feed
// (iMessage, Reddit, X, Slack…) as that page, not the generic banner.
// api/share.js points og:image here.
//
// Shared articles never change, so a card is cached by Vercel's CDN for a
// long time and drawn once per share, not once per view.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "@vercel/og";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

// Bundled with the function (see vercel.json's includeFiles).
const asset = (p) => readFileSync(join(process.cwd(), "api", p));
const FONTS = [
  { name: "Fraunces", data: asset("_fonts/fraunces-600.ttf"), weight: 600, style: "normal" },
  { name: "Fraunces", data: asset("_fonts/fraunces-italic-600.ttf"), weight: 600, style: "italic" },
  { name: "Inter", data: asset("_fonts/inter-500.ttf"), weight: 500, style: "normal" },
  { name: "JetBrains Mono", data: asset("_fonts/jetbrains-mono-500.ttf"), weight: 500, style: "normal" },
];
const LOGO = `data:image/png;base64,${asset("_assets/logo.png").toString("base64")}`;

// Satori takes React-element-shaped objects; this keeps the file free of JSX.
const h = (type, style, ...children) => ({ type, props: { style, children: children.length === 1 ? children[0] : children } });

// The article's opening line(s), plain, cut at a sentence near `max`.
function openingLine(text, max = 170) {
  const plain = String(text || "")
    .replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

// The card carries the hook (the article's opening line); the title itself
// shows as text right under the image in messages and feeds, so repeating it
// in the picture would just say it twice. Without a line, the title is the
// big text instead.
function hookSize(text) {
  if (text.length <= 70) return 64;
  if (text.length <= 110) return 56;
  if (text.length <= 150) return 48;
  return 42;
}

export function renderCard({ title, line }) {
  const hook = line || title;
  return new ImageResponse(
    h(
      "div",
      {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "56px 72px 52px",
        backgroundColor: "#14100C",
        backgroundImage: "radial-gradient(circle at 80% 15%, #2E2216 0%, #1A140E 45%, #100C09 100%)",
        fontFamily: "Inter",
        color: "#F1E6D3",
      },
      { type: "img", props: { src: LOGO, width: 150, height: 78, style: { opacity: 0.95 } } },
      h(
        "div",
        { display: "flex", fontFamily: "Fraunces", fontStyle: "italic", fontSize: hookSize(hook), lineHeight: 1.18, color: "#F1E6D3", maxWidth: 1050 },
        hook
      ),
      h(
        "div",
        { display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: "2px solid rgba(227,167,60,0.45)", paddingTop: 22 },
        h("div", { display: "flex", fontFamily: "JetBrains Mono", fontSize: 20, letterSpacing: 6, color: "#A89478" }, "THINKING WITH THREADS"),
        h("div", { display: "flex", fontFamily: "Fraunces", fontStyle: "italic", fontSize: 34, color: "#E3A73C" }, "hyfax.app")
      )
    ),
    { width: 1200, height: 630, fonts: FONTS }
  );
}

export default async function handler(req, res) {
  const id = typeof req.query?.id === "string" ? req.query.id : "";
  let row = null;
  if (/^[A-Za-z0-9]+$/.test(id)) {
    try {
      const apiRes = await fetch(
        `${SUPABASE_URL}/rest/v1/shared_articles?id=eq.${encodeURIComponent(id)}&select=topic_label,node_type,overview,article`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
      );
      if (apiRes.ok) row = (await apiRes.json())?.[0] ?? null;
    } catch (e) {
      console.error("api/og: fetch failed", e);
    }
  }

  // An unknown id still gets a branded card rather than a broken image.
  const card = row
    ? renderCard({ title: row.topic_label, line: openingLine(row.overview || row.article) })
    : renderCard({ title: "Problem solving isn't linear. Neither is your learning." });

  const png = Buffer.from(await card.arrayBuffer());
  res.status(200);
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", row ? "public, max-age=86400, s-maxage=31536000, immutable" : "public, max-age=300");
  res.end(png);
}
