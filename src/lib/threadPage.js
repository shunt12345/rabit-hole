// A thread page's article, in the What / Why / Where format. The article
// call writes it as plain text in this layout (see ARTICLE_TASK in
// hyfaxSystemPrompt.js), after the optional title line:
//
//   WHAT: one direct, factual paragraph
//
//   WHY IT HAPPENS: Subtitle | Catch line
//   paragraph
//
//   WHY IT MATTERS: Subtitle | Catch line
//   paragraph
//
// "Where" is the page's thread cards (the expand call), not part of this
// text. A page saved before this format has no markers; it parses as a
// legacy page and shows its paragraphs as they are.

const LINK_MARKER_RE = /\[\[([^[\]|]+?)(?:\|[^\]]*)?\]\]/g;
// Labels are matched loosely (any case, stray markdown bold, ":" or "|"
// after the label) so a near-miss from the model still lays out.
const SECTION_RE = /^[ \t]*\**[ \t]*(WHAT|WHY IT HAPPENS|WHY IT MATTERS)[ \t]*\**[ \t]*[:|][ \t]*\**[ \t]*/gim;
const WHY_KINDS = { "WHY IT HAPPENS": "Why it happens", "WHY IT MATTERS": "Why it matters" };
const MARKERS = ["WHAT:", "WHY IT HAPPENS:", "WHY IT MATTERS:"];

const clean = (s) => (s || "").replace(LINK_MARKER_RE, "$1").trim();

// While the text streams in, a marker arrives a few letters at a time; a
// last line that's only the start of one ("WHY IT HA") is held back so it
// never flashes inside the paragraph above it.
function dropPartialMarker(text) {
  const lines = text.split("\n");
  const last = lines[lines.length - 1].trim();
  const up = last.replace(/^\*+/, "").toUpperCase();
  if (up && MARKERS.some((m) => m.startsWith(up) && m !== up)) {
    lines.pop();
    return lines.join("\n");
  }
  return text;
}

export function parseThreadPage(raw) {
  const text = dropPartialMarker(raw || "");
  const marks = [...text.matchAll(SECTION_RE)];
  if (!marks.length) {
    return { structured: false, what: "", whys: [], paragraphs: text.split(/\n\s*\n/).map(clean).filter(Boolean) };
  }
  // No WHAT label: whatever came before the first Why is the What.
  let what = marks[0][1].toUpperCase() === "WHAT" ? "" : clean(text.slice(0, marks[0].index).replace(/\n\s*\n/g, " "));
  const whys = [];
  marks.forEach((m, i) => {
    const label = m[1].toUpperCase();
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const chunk = text.slice(start, end).trim();
    if (label === "WHAT") {
      what = clean(chunk.replace(/\n\s*\n/g, " "));
      return;
    }
    const [head, ...rest] = chunk.split("\n");
    const bar = head.indexOf("|");
    let hook = bar === -1 ? "" : clean(head.slice(bar + 1));
    let body = rest.join("\n").trim();
    // The paragraph written on the header line itself ("Subtitle | Catch
    // line. The whole paragraph..."): the first sentence is the catch line,
    // the rest is the body.
    if (hook && !body) {
      const m = hook.match(/^(.+?[.!?]["')\]]*)\s+(\S[\s\S]*)$/);
      if (m && m[2].split(/\s+/).length >= 12) {
        hook = m[1];
        body = m[2];
      }
    }
    // No catch line on the header: a one-sentence first paragraph above a
    // longer body is the catch line.
    if (!hook) {
      const paras = body.split(/\n\s*\n/);
      if (paras.length > 1 && !/[.!?]["')\]]*\s+\S/.test(paras[0].trim())) {
        hook = clean(paras.shift());
        body = paras.join("\n\n");
      }
    }
    whys.push({
      kind: WHY_KINDS[label],
      subtitle: clean((bar === -1 ? head : head.slice(0, bar)).replace(/\*+/g, "")),
      hook: hook.replace(/\*+/g, ""),
      body: clean(body.replace(/\n\s*\n/g, "\n\n")),
    });
  });
  return { structured: true, what, whys, paragraphs: [] };
}

// True when a page came back with the layout's own placeholder words in
// its Why headers ("WHY IT HAPPENS: Subtitle | Catch line"), copied from
// the instructions instead of written. Such a page isn't saved for other
// readers (seen live from Sonnet before it was shown example pages).
export function hasPlaceholderHeaders(raw) {
  return /^\s*WHY IT (HAPPENS|MATTERS)\s*:\s*<?\s*subtitle\s*>?\s*\|/im.test(raw || "") || /\|\s*<?\s*catch line\s*>?\s*$/im.test(raw || "");
}

// The page as plain prose, for places that need text rather than layout:
// a shared link's page, the "continue exploring" preview line, and the
// expand prompt (so the Where cards go somewhere the page doesn't).
export function threadPagePlainText(raw) {
  const page = parseThreadPage(raw);
  if (!page.structured) return page.paragraphs.join("\n\n");
  return [page.what, ...page.whys.map((w) => w.body)].filter(Boolean).join("\n\n");
}
