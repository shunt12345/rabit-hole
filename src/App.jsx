import { useState, useRef, useEffect, Fragment } from "react";
import { Loader2, RotateCcw, Sparkles, ArrowUpRight, AlertCircle, BookOpen, ChevronRight, ChevronDown } from "lucide-react";
import {
  callClaude,
  streamJSON,
  streamTextFromPrompt,
  getLastActionsToday,
  getLastTrialStatus,
  writeNewsRootCache,
  TrialExhaustedError,
} from "./lib/api.js";
import { HYPHA_SYSTEM, OBSCURITY_LEVELS, FIXED_OBSCURITY } from "./lib/hyphaSystemPrompt.js";
import { createPacedReveal } from "./lib/pacedReveal.js";
import { getCurrentUser, onAuthStateChange } from "./lib/auth.js";
import { getProfile } from "./lib/profile.js";
import AccountMenu from "./AccountMenu.jsx";
import LegalModal from "./LegalModal.jsx";

const TYPE_COLOR = {
  root: "#C1552E",
  direct: "#E3A73C",
  indirect: "#7E9471",
  tangent: "#9C6B8C",
  custom: "#6C93A8",
};

const TYPE_LABEL = {
  direct: "Direct",
  indirect: "Indirect",
  tangent: "Tangent",
  custom: "Yours",
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A defensive cleanup, not just a prompt instruction — telling the model
// "no markdown" doesn't reliably stop it from reaching for *asterisks* to
// represent emphasis, especially under an enthusiastic tone that invites
// emphasis in the first place. Since this app renders plain text with no
// markdown parser, any asterisk that slips through shows up literally
// instead of turning into actual styling — so strip them outright rather
// than trust compliance alone. Runs on every streamed chunk as it arrives,
// not just the final text, so stray formatting never flashes on screen
// even mid-stream.
function stripMarkdown(text) {
  return text
    .replace(/\*{3,}/g, "") // *** or longer used as a bare separator/flourish
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/\*([^*]+)\*/g, "$1") // *italic*
    .replace(/\*+/g, ""); // anything left over, including an unmatched opening asterisk mid-stream
}

// turns any exact-name mention of a child's label inside a block of text
// into a clickable piece — used for both the short teaser/overview and the
// full article, so a name only needs to be written once to become a link
// wherever it shows up
function linkifyText(text, children) {
  if (!children || !children.length || !text) return [text];
  const sorted = [...children].sort((a, b) => b.label.length - a.label.length);
  const pattern = new RegExp(`(${sorted.map((c) => escapeRegExp(c.label)).join("|")})`, "g");
  const pieces = text.split(pattern);
  const byLabel = new Map(children.map((c) => [c.label, c]));
  return pieces.map((piece) => {
    const child = byLabel.get(piece);
    return child ? { type: "link", label: piece, nodeId: child.id } : piece;
  });
}

// "Read more" content: real prose, not JSON, so no parsing needed beyond
// trimming stray markdown fences a model might add out of habit. Streams
// the article as it's generated instead of waiting for the whole thing —
// parses the API's server-sent-event chunks directly and calls onChunk
// with the accumulated text so far after every delta, so the screen can
// render it growing in real time rather than sitting on a spinner.
async function fetchArticleTextStreaming(topicLabel, path, childLabels, onChunk, newsContext) {
  const branchNote =
    childLabels && childLabels.length
      ? `\n\nThis topic already branches into these related threads: ${childLabels.join(", ")}.`
      : "";
  const newsNote = newsContext
    ? `\n\nThis topic was picked from a live "In the news" feed because of a specific current story: "${newsContext}".`
    : "";
  const userContent = `TASK: read-more article

Path so far: ${path.join(" → ")}
Topic: "${topicLabel}"${newsNote}${branchNote}`;

  return streamTextFromPrompt(HYPHA_SYSTEM, userContent, 700, 30000, "article", onChunk);
}

// "Dig deeper" — this app is entertainment, not a research tool, so this is
// deliberately capped to ONE extra round per node (enforced by the caller
// via node.deepened) rather than open-ended pagination. The prompt gets the
// existing article text so it can continue naturally instead of repeating
// itself, and is explicitly told not to try to be exhaustive — a
// satisfying next layer for someone who wants a little more, not a
// dissertation.
async function fetchArticleContinuationStreaming(topicLabel, path, existingArticle, onChunk) {
  const userContent = `TASK: continue article

Path so far: ${path.join(" → ")}
Topic: "${topicLabel}"

What they already read:
"""
${existingArticle}
"""`;

  return streamTextFromPrompt(HYPHA_SYSTEM, userContent, 500, 30000, "continuation", onChunk);
}

function branchMix() {
  return OBSCURITY_LEVELS[FIXED_OBSCURITY].mix;
}

// The prompt ASKS for an exact branch mix, but nothing enforced that on the
// way back — the raw API response was passed straight through, so any time
// the model returned an extra item (a common way models drift from numeric
// constraints, especially across several categories at once) it just
// silently rendered, throwing off the intended mix. This caps each
// category at its real target count, dropping any overflow, and ignores
// any item with a type that isn't one of the three real branch types at all.
function normalizeChildren(rawChildren) {
  const mix = branchMix();
  const buckets = { direct: [], indirect: [], tangent: [] };
  (rawChildren || []).forEach((c) => {
    if (buckets[c.type]) buckets[c.type].push(c);
  });
  return [...buckets.direct.slice(0, mix.direct), ...buckets.indirect.slice(0, mix.indirect), ...buckets.tangent.slice(0, mix.tangent)];
}

function rootPrompt(topic, newsContext) {
  const newsNote = newsContext
    ? `\n\nThis topic was picked from a live "In the news" feed because of a specific current story: "${newsContext}".`
    : "";
  return `TASK: root topic

Starting topic: "${topic}"${newsNote}`;
}

function childPrompt(label, path, existingLabels, depth) {
  return `TASK: expand node

Path so far: ${path.join(" → ")}
Now expanding: "${label}" (${depth} click${depth === 1 ? "" : "s"} away from the original topic)

Do not repeat or closely rephrase any of these already-shown labels: ${
    existingLabels.slice(-40).join(", ") || "none"
  }`;
}

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return idCounter;
}

// Real live topics now — see supabase/functions/generate-trending-topics.
// A scheduled job (pg_cron, twice daily) does one Claude web-search call per
// field — 3 news fields plus 2 date-anchored ones ("National Day", "This
// Day In History") — and caches each result in trending_topics_cache; this
// just reads a batch of recent rows with the anon key. No live search
// happens on the client or per page load. NEWS_FIELDS / SPECIAL_FIELDS below
// pick the latest row per named field out of that batch, so a field that's
// been renamed or retired (like the old "Culture & Arts") just stops
// rendering on its own instead of lingering until its rows age out.
const TRENDING_TOPICS_URL = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/trending_topics_cache?select=field,topic,teaser,source_url,generated_at&order=generated_at.desc,id.desc&limit=20`;
const NEWS_FIELDS = ["World News", "Science", "Technology"];
const SPECIAL_FIELDS = ["National Day", "This Day In History"];

// Picks the single most recent row for each field in `fields`, in that
// order — not just the first N rows in the batch, since stale rows from a
// retired field or a partially-failed cron run could otherwise crowd out a
// field that's actually still active.
function latestByField(rows, fields) {
  return fields
    .map((field) => rows.find((r) => r.field === field))
    .filter(Boolean);
}

// UI-only mockup of the 3-tier ad placement sketch — hardcoded placeholder
// content, no real sponsor backend, always on (not gated behind any real
// "should we show an ad here" logic yet). Swap this for real sponsored
// data — and add real gating — when this becomes more than a mockup.
const MOCK_SPONSOR = {
  tier1: {
    brand: "Farside Media",
    headline: "The Deep End: A Show About Falling Down Rabbit Holes",
    description:
      "A weekly documentary series that picks one wildly specific obsession and actually chases it all the way down.",
    cta: "Watch the first episode",
  },
  tier2: {
    brand: "Longshelf",
    text: "Turn today's curiosity into your next real book — a new nonfiction pick every week.",
    cta: "See this week's pick",
  },
  tier3: {
    brand: "Farside Media",
    label: "The Deep End",
  },
  // The app's own landing screen, below "In the news" — separate slot
  // from tier1 (which sits on a topic's own page once you've dug in).
  landing: {
    brand: "Farside Media",
    headline: "The Deep End: A Show About Falling Down Rabbit Holes",
    description: "A weekly documentary series that picks one wildly specific obsession and actually chases it all the way down.",
    cta: "Watch the trailer",
  },
};

export default function Hypha() {
  const [topic, setTopic] = useState("");
  const [inputVal, setInputVal] = useState("");
  const [nodes, setNodes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState(null);
  const [rootPreview, setRootPreview] = useState("");
  // { nodeId, text } — the currently-typing teaser for a node that was just
  // selected and is still being expanded (its own branches + article are
  // still generating). Not real streaming (the teaser text is already
  // known, from the parent's response) — a deliberate typing animation so
  // clicking "Explore next" gives the same "the app is working" cue as
  // submitting a fresh topic does, instead of a bare loading spinner.
  const [childPreview, setChildPreview] = useState(null);
  const [trendingTopics, setTrendingTopics] = useState([]);
  // Which "In the news" card was clicked, so only that one highlights
  // instead of all three dimming identically once rootLoading flips on.
  const [selectedNewsIdx, setSelectedNewsIdx] = useState(null);
  // Same idea, for the separate "National Day" / "This Day In History" pair.
  const [selectedTodayIdx, setSelectedTodayIdx] = useState(null);
  // Raw action count from the proxy's X-Session-Actions-Today header —
  // kept for the existing 300/day safety-net visibility; the real
  // free-trial gate (below) is search-count-based, not this.
  const [actionsToday, setActionsToday] = useState(0);
  // Section B of the production punch list (free-tier enforcement) — real
  // trial status from the proxy: how many free searches used, the limit,
  // and whether this identity is funded (and so not gated at all). Drives
  // hiding/disabling News/Today/Dig Deeper once the trial's used up.
  // Starts optimistic (assume within trial) since the real status isn't
  // known until after the first proxy call of the session.
  const [trialStatus, setTrialStatus] = useState({ searchesUsed: 0, searchLimit: 6, funded: false });
  const syncActionsToday = () => {
    const n = getLastActionsToday();
    if (n != null) setActionsToday(n);
    const t = getLastTrialStatus();
    if (t != null) setTrialStatus(t);
  };

  // Accounts (production punch list, Section A) — first pass: just knowing
  // who's signed in. Nothing reads `user` to change behavior yet (no
  // balance, no feature toggles, no re-pointed rate limiting) — those are
  // separate, later builds. null = signed out, an object = signed in.
  const [user, setUser] = useState(null);
  useEffect(() => {
    getCurrentUser().then(setUser);
    return onAuthStateChange(setUser);
  }, []);

  // Production punch list, Section C (funded experience): the signed-in
  // user's own feature-toggle preferences (News/Today/Dig Deeper — Explore
  // node count is deliberately excluded, see AccountMenu.jsx). null while
  // signed out or still loading; refreshed whenever `user` changes
  // (including after AccountMenu writes a toggle, since that flips through
  // the same auth state) and passed down so AccountMenu doesn't need a
  // second, out-of-sync copy of the same row.
  const [profile, setProfile] = useState(null);
  const refreshProfile = () => {
    if (!user) {
      setProfile(null);
      return;
    }
    getProfile().then(setProfile);
  };
  useEffect(refreshProfile, [user]);

  // Real-time "is this account funded" check, computed directly from the
  // profile row (fetched independently, on sign-in and after checkout)
  // rather than trialStatus.funded. That field only updates after a full
  // round-trip through rabbit-hole-proxy, so relying on it here meant a
  // signed-in funded user could sit on a stale "not funded" read (from the
  // optimistic initial state, or simply not having made a proxy call yet
  // this session) — which made toggling News/Today off look broken, since
  // the gating below always falls back to "show everything" whenever it
  // doesn't yet believe the account is funded. profile.balanceUsd is a
  // straight read of the real row, so this can't lag behind reality.
  const funded = !!profile && profile.balanceUsd > 0;

  // Toggle gating only ever applies to a FUNDED account — the free-trial
  // window (not yet exhausted, per Section B) keeps its existing
  // unconditional full access regardless of any toggle's stored default,
  // matching the monetization outline doc's Section 14.1 ("full access to
  // every function" during the trial, à-la-carte toggles only once funded).
  const trialExhausted = !funded && trialStatus.searchesUsed >= trialStatus.searchLimit;
  const newsVisible = !funded || !!profile?.featureNews;
  const todayVisible = !funded || !!profile?.featureToday;
  const digDeeperVisible = !funded || !!profile?.featureDigDeeper;

  const nodesRef = useRef([]);
  const selectedIdRef = useRef(null);
  const contentRef = useRef(null);
  const articleTextRef = useRef(null);
  const childPreviewRevealRef = useRef(null);

  // Highlight-to-explore: uses the browser's OWN native text selection
  // (long-press then drag the OS's own handles, exactly like copying text)
  // rather than building custom drag handles — the OS already does that
  // well, and reinventing it would both be a lot of fragile work and would
  // fight whatever the platform already does natively. This just watches
  // for a selection to settle inside the article text specifically (not
  // the title, not a chip label) and offers a button near it.
  //
  // selectionchange fires continuously while dragging the selection handles
  // — many times a second — so this is debounced to update only once the
  // selection has actually settled, both to avoid visible jitter in the
  // floating button's position and to avoid re-rendering on every tiny
  // handle movement.
  const [selectionInfo, setSelectionInfo] = useState(null); // { text, top, left } | null
  const [legalDoc, setLegalDoc] = useState(null); // "terms" | "privacy" | null
  const selectionDebounceRef = useRef(null);
  useEffect(() => {
    const handleSelectionChange = () => {
      if (selectionDebounceRef.current) clearTimeout(selectionDebounceRef.current);
      selectionDebounceRef.current = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          setSelectionInfo(null);
          return;
        }
        const text = sel.toString().trim();
        // an empty/whitespace-only selection, or something absurdly long
        // (someone dragged across several paragraphs) isn't a real "what's
        // this word/phrase" moment — bail out rather than offer to explore
        // half an article as a single topic
        if (!text || text.length > 80) {
          setSelectionInfo(null);
          return;
        }
        const range = sel.getRangeAt(0);
        if (!articleTextRef.current || !articleTextRef.current.contains(range.commonAncestorContainer)) {
          setSelectionInfo(null);
          return;
        }
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          setSelectionInfo(null);
          return;
        }
        setSelectionInfo({ text, bottom: rect.bottom, left: rect.left + rect.width / 2 });
      }, 150);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (selectionDebounceRef.current) clearTimeout(selectionDebounceRef.current);
    };
  }, []);

  // 100vh (and window.innerHeight) is unreliable once the mobile keyboard
  // opens — it doesn't shrink to the actual visible area, so the page stays
  // sized for the full pre-keyboard height and the browser has to improvise
  // scroll compensation to keep the focused input in view. window.visualViewport
  // DOES track the keyboard correctly and is what the layout should actually
  // be driven by instead.
  const getViewportH = () => {
    if (typeof window === "undefined") return 800;
    return window.visualViewport ? window.visualViewport.height : window.innerHeight;
  };
  const [viewportH, setViewportH] = useState(getViewportH);
  useEffect(() => {
    const update = () => setViewportH(getViewportH());
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update); // some browsers report keyboard changes via scroll, not resize
    } else {
      window.addEventListener("resize", update);
    }
    return () => {
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      } else {
        window.removeEventListener("resize", update);
      }
    };
  }, []);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Every navigation — a chip, a breadcrumb segment, an in-text link, or a
  // fresh topic — should land you at the top of the new content, not
  // wherever you happened to have scrolled to on the previous one.
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    setSelectionInfo(null);
  }, [selectedId]);

  // Creates the child node objects — no position/layout concerns at all
  // here, since there's no graph to place anything on.
  const placeChildren = (parent, children) =>
    children.map((c) => ({
      ...c,
      id: nextId(),
      parentId: parent.id,
      depth: parent.depth + 1,
      generated: false,
      loading: false,
      error: null,
      article: null,
      articleLoading: false,
      articleStreaming: false,
      articleError: null,
      deepened: false,
      deepenError: null,
    }));

  // Tapping the button always does this synchronously and immediately, regardless
  // of anything else — proves the click registered even if startTopic itself
  // fails in some unexpected way.
  const handleStartClick = () => {
    console.log("Hypha: Dig in tapped, value =", JSON.stringify(inputVal));
    try {
      if (!inputVal.trim()) {
        setRootError("Type a topic first.");
        return;
      }
      setSelectedNewsIdx(null);
      setSelectedTodayIdx(null);
      startTopic(inputVal);
    } catch (syncErr) {
      console.error("Hypha: synchronous error on click", syncErr);
      setRootError(`Unexpected error: ${syncErr.message || syncErr}`);
      setRootLoading(false);
    }
  };

  const startTopic = async (raw, newsContext) => {
    const t = raw.trim();
    if (!t) return;
    setRootError(null);
    setRootLoading(true);
    setRootPreview("");
    idCounter = 0;

    // Streams the overview in at reading pace while the rest of the JSON
    // (children, etc.) keeps generating — the wait feels like reading
    // something appear rather than staring at a spinner. `finish` is
    // awaited below so the reveal has visibly caught up before the screen
    // switches over to the real root node.
    const reveal = createPacedReveal((revealed) => setRootPreview(revealed));

    try {
      // A topic from the "In the news"/"Today" hero cards (newsContext set)
      // is identical for every visitor until the next trending-topics
      // refresh — hundreds of people can open the same card. Tag those
      // calls with the exact topic string as a cache key so the proxy can
      // skip straight to whatever the first visitor generated instead of
      // re-generating per person; a freely typed topic always gets its own
      // fresh generation, no cache key. Always streams either way — an
      // earlier version forced non-streaming for the cached path so the
      // proxy could cache the result inline, which added a real 1-2s of
      // visible latency on every cache miss (waiting for the whole
      // generation before showing anything, instead of watching it type
      // in). The write-through below replaces that: it happens as its own
      // request, after this one has already finished streaming.
      const newsCacheKey = newsContext ? t : undefined;
      const data = await streamJSON(
        HYPHA_SYSTEM,
        rootPrompt(t, newsContext),
        "root",
        (partialOverview) => reveal.push(partialOverview),
        newsCacheKey
      );
      if (newsCacheKey) {
        writeNewsRootCache(newsCacheKey, data.rootLabel, data.overview, data.children);
      }
      await reveal.finish(data.overview || "");
      const root = {
        id: nextId(),
        label: (data.rootLabel && data.rootLabel.trim()) || t,
        fullTopic: t,
        teaser: "",
        overview: data.overview || "",
        type: "root",
        depth: 0,
        generated: true,
        loading: false,
        error: null,
        article: null,
        articleLoading: false,
        articleStreaming: false,
        articleError: null,
        deepened: false,
        deepenError: null,
        newsContext: newsContext || null,
      };
      const children = placeChildren(root, normalizeChildren(data.children));
      const newNodes = [root, ...children];

      setTopic(t);
      nodesRef.current = newNodes;
      setNodes(newNodes);
      setSelectedId(root.id);
    } catch (e) {
      console.error("Hypha: startTopic failed", e);
      reveal.cancel();
      setSelectedNewsIdx(null);
      setSelectedTodayIdx(null);
      setRootError(e.message || "Something went wrong. Try again.");
    } finally {
      setRootLoading(false);
      setRootPreview("");
      syncActionsToday();
    }
  };

  // Reads a starting topic straight from the URL on load, e.g.
  // ?topic=octopus%20cognition — the foundation piece for anything that
  // wants to hand off INTO Hypha from somewhere else (a bookmarklet,
  // a browser extension, a link shared from another app). This alone
  // doesn't capture text from other webpages — it's the landing side of
  // that handoff, what any of those tools would actually link to. Only
  // fires once, on first mount, and only if nothing's already loaded, so
  // it can't interfere with normal typed-topic use or accidentally
  // re-trigger on re-renders.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const urlTopic = params.get("topic");
      if (urlTopic && urlTopic.trim() && nodesRef.current.length === 0) {
        startTopic(urlTopic);
      }
    } catch (e) {
      console.error("Hypha: failed to read topic from URL", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetches the latest cached batch of "In the news" topics — a plain read
  // against Supabase's REST API with the anon key (RLS allows public
  // SELECT on this table). Fails silently: if it's empty or the request
  // errors, the section just doesn't render rather than showing an error
  // on the hero page over what's a nice-to-have, not core functionality.
  useEffect(() => {
    let cancelled = false;
    fetch(TRENDING_TOPICS_URL, {
      headers: {
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      },
    })
      .then((res) => (res.ok ? res.json() : []))
      .then((rows) => {
        if (!cancelled) setTrendingTopics(Array.isArray(rows) ? rows : []);
      })
      .catch((e) => console.error("Hypha: failed to load trending topics", e));
    return () => {
      cancelled = true;
    };
  }, []);

  const pathToNode = (node) => {
    const path = [];
    let cur = node;
    while (cur) {
      path.unshift(cur.label);
      cur = nodesRef.current.find((n) => n.id === cur.parentId);
    }
    return path;
  };

  // same idea as pathToNode, but returns the actual node objects (root
  // first) instead of just their labels — what the breadcrumb trail renders
  const nodePathToRoot = (node) => {
    const path = [];
    let cur = node;
    while (cur) {
      path.unshift(cur);
      cur = nodesRef.current.find((n) => n.id === cur.parentId);
    }
    return path;
  };

  const expandNode = async (nodeId) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node || node.generated || node.loading) return;
    node.loading = true;
    node.error = null;
    setNodes([...nodesRef.current]);

    const path = pathToNode(node);
    const existingLabels = nodesRef.current.map((n) => n.label);

    try {
      const data = await callClaude(HYPHA_SYSTEM, childPrompt(node.label, path, existingLabels, node.depth + 1), "expand");
      const children = placeChildren(node, normalizeChildren(data.children));
      node.loading = false;
      node.generated = true;
      const newNodes = [...nodesRef.current, ...children];
      nodesRef.current = newNodes;
      setNodes(newNodes);
    } catch (e) {
      console.error("Hypha: expandNode failed", e);
      node.loading = false;
      node.error = e.message || "Dig failed — try again.";
      setNodes([...nodesRef.current]);
    } finally {
      syncActionsToday();
    }
  };

  // Fetches the full "read more" article for a node, on demand — nothing is
  // fetched until the person actually opens that node. The article streams
  // in as it's generated rather than appearing all at once when it's done,
  // so reading starts within a second or two; the result is cached on the
  // node so re-opening it later never re-streams.
  const loadArticle = async (nodeId) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node || node.article || node.articleLoading) return;
    node.articleLoading = true;
    node.articleStreaming = false;
    node.articleError = null;
    setNodes([...nodesRef.current]);

    const path = pathToNode(node);
    const childLabels = nodesRef.current.filter((n) => n.parentId === node.id).map((n) => n.label);
    const reveal = createPacedReveal((revealed) => {
      node.article = stripMarkdown(revealed);
      setNodes([...nodesRef.current]);
    });
    try {
      let first = true;
      const finalText = await fetchArticleTextStreaming(
        node.label,
        path,
        childLabels,
        (partial) => {
          if (first) {
            node.articleLoading = false;
            node.articleStreaming = true;
            first = false;
            setNodes([...nodesRef.current]);
          }
          reveal.push(partial);
        },
        node.newsContext
      );
      await reveal.finish(finalText);
      node.article = stripMarkdown(finalText);
      node.articleStreaming = false;
      node.articleLoading = false;
    } catch (e) {
      console.error("Hypha: loadArticle failed", e);
      reveal.cancel();
      node.articleLoading = false;
      node.articleStreaming = false;
      node.article = null;
      node.articleError = e.message || "Couldn't load more — try again.";
    }
    syncActionsToday();
    setNodes([...nodesRef.current]);
  };

  // "Dig deeper" — capped to one extra round per node (the `deepened` flag
  // below), reusing the same streaming cursor UI as the initial load by
  // appending onto the existing text rather than replacing it. Unlike a
  // failed initial load (which has nothing worth keeping), a failed
  // continuation reverts to the article as it was before the attempt
  // rather than destroying content that was already there and working.
  const deepenArticle = async (nodeId) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node || !node.article || node.deepened || node.articleLoading || node.articleStreaming) return;
    const baseArticle = node.article;
    node.articleStreaming = true;
    node.deepenError = null;
    setNodes([...nodesRef.current]);

    const path = pathToNode(node);
    const reveal = createPacedReveal((revealed) => {
      node.article = `${baseArticle}\n\n${stripMarkdown(revealed)}`;
      setNodes([...nodesRef.current]);
    });
    try {
      const finalText = await fetchArticleContinuationStreaming(node.label, path, baseArticle, (partial) => {
        reveal.push(partial);
      });
      await reveal.finish(finalText);
      node.article = `${baseArticle}\n\n${stripMarkdown(finalText)}`;
      node.articleStreaming = false;
      node.deepened = true;
    } catch (e) {
      console.error("Hypha: deepenArticle failed", e);
      reveal.cancel();
      node.article = baseArticle;
      node.articleStreaming = false;
      node.deepenError = e.message || "Couldn't dig deeper — try again.";
    }
    syncActionsToday();
    setNodes([...nodesRef.current]);
  };

  // Selecting anything — a chip, a breadcrumb segment, an in-text link, or
  // the root as soon as a topic is submitted — starts loading both its
  // branches and its full "read more" article, with no extra taps required
  // for either.
  //
  // Branches and article both start loading automatically, but NOT in true
  // parallel: if this node's branches don't exist yet, we wait for them (a
  // fast, small JSON call) before starting the article, so its prompt can
  // actually reference the real branch names and produce real in-text
  // links — the same way the root's article always could, since the root's
  // branches are created in the same call as its overview. If a node was
  // already expanded before (revisiting it, or it's the root), its
  // branches are already known and the article starts right away.
  useEffect(() => {
    if (!selectedId) return;
    const node = nodesRef.current.find((n) => n.id === selectedId);
    if (!node) return;

    if (node.generated) {
      if (!node.article && !node.articleLoading) {
        loadArticle(selectedId);
      }
    } else if (!node.loading) {
      childPreviewRevealRef.current?.cancel();
      setChildPreview(null);
      const reveal = createPacedReveal((revealed) => setChildPreview({ nodeId: selectedId, text: revealed }));
      childPreviewRevealRef.current = reveal;
      reveal.push(node.teaser || "");
      reveal.finish(node.teaser || "");

      expandNode(selectedId).finally(() => {
        if (selectedIdRef.current !== selectedId) return; // moved on to something else meanwhile
        setChildPreview(null); // node.generated is now true — the real render path takes over
        const fresh = nodesRef.current.find((n) => n.id === selectedId);
        if (fresh && !fresh.article && !fresh.articleLoading) {
          loadArticle(selectedId);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const reset = () => {
    nodesRef.current = [];
    setNodes([]);
    setSelectedId(null);
    setTopic("");
    setInputVal("");
    setRootError(null);
    idCounter = 0;
  };

  const jumpToNode = (nodeId) => {
    setSelectedId(nodeId);
  };

  // Turns a highlighted word or phrase from the article into a new node —
  // same underlying mechanism the typed "explore your own thread" input
  // used to use, just triggered by a native text selection instead of
  // typing. Clears the browser's own selection afterward so the
  // highlight doesn't linger once you've already navigated away from it.
  const exploreSelection = () => {
    if (!selectionInfo) return;
    const parent = nodesRef.current.find((n) => n.id === selectedId);
    const text = selectionInfo.text;
    if (!parent || !text) return;
    const label = text.length > 60 ? text.slice(0, 59) + "…" : text;
    const [child] = placeChildren(parent, [{ label, teaser: "", type: "custom" }]);
    const newNodes = [...nodesRef.current, child];
    nodesRef.current = newNodes;
    setNodes(newNodes);
    setSelectionInfo(null);
    window.getSelection().removeAllRanges();
    setSelectedId(child.id);
  };

  const renderLinked = (text, children) =>
    linkifyText(text, children).map((piece, i) =>
      typeof piece === "string" ? (
        <span key={i}>{piece}</span>
      ) : (
        <button
          key={i}
          onClick={() => jumpToNode(piece.nodeId)}
          className="rh-link-accent"
          style={{ color: "#E3A73C", fontWeight: 500, textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: "2px" }}
        >
          {piece.label}
        </button>
      )
    );

  const hasStarted = nodes.length > 0;
  const newsTopics = latestByField(trendingTopics, NEWS_FIELDS);
  const todayTopics = latestByField(trendingTopics, SPECIAL_FIELDS);
  const selected = nodes.find((n) => n.id === selectedId) || null;
  const selectedChildren = selected ? nodes.filter((n) => n.parentId === selected.id) : [];
  const breadcrumb = selected ? nodePathToRoot(selected) : [];

  return (
    <div className="w-full flex flex-col rh-body" style={{ backgroundColor: "#14100C", height: viewportH }}>
      <style>{`
        /* Fraunces requested WITHOUT the opsz (optical size) axis range —
           with it, some Android renderers interpolate the italic instance
           incorrectly at large sizes and flip specific glyphs (f, t)
           upside down. Fixed static optical size avoids the bad
           interpolation entirely. */
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;1,500&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
        .rh-display { font-family: 'Fraunces', serif; }
        .rh-body { font-family: 'Inter', sans-serif; }
        .rh-mono { font-family: 'JetBrains Mono', monospace; }
        .rh-fade-in { animation: rh-fadein 0.4s ease both; }
        @keyframes rh-fadein { from { opacity: 0; transform: translateY(6px);} to { opacity: 1; transform: translateY(0);} }
        .rh-placeholder::placeholder { color: #6B5B45; }
        .rh-input:focus { border-color: #E3A73C !important; }
        .rh-btn-dark:hover { background-color: #2A2018 !important; }
        .rh-btn-accent:hover { background-color: #EDB94F !important; }
        .rh-link-accent:hover { color: #EDB94F !important; }
        .rh-logo-btn { transition: opacity 0.15s; }
        .rh-logo-btn:hover { opacity: 0.8; }
        .rh-chip:hover { filter: brightness(1.15); }
        .rh-crumb:hover { color: #EDB94F !important; }
        .rh-text-10 { font-size: 10px; }
        .rh-tracking-30 { letter-spacing: 0.3em; }
        .rh-tracking-25 { letter-spacing: 0.25em; }
        .rh-hero-headline { font-size: 2.6rem; line-height: 1.05; }
        @keyframes rh-blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0; } }
        .rh-cursor-blink { display: inline-block; animation: rh-blink 1s step-end infinite; margin-left: 1px; }
      `}</style>

      {/* header — always present, right side only once a topic exists */}
      <div className="grid grid-cols-3 items-start p-5 md:p-7 shrink-0">
        <div />
        <div className="flex flex-col items-center text-center">
          <h1 className="flex items-center">
            <button
              type="button"
              onClick={reset}
              aria-label="Back to home"
              className="flex items-center rh-logo-btn"
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
            >
              <img src="/hypha-logo.png" alt="Hypha" className="h-8 md:h-10 w-auto" />
            </button>
          </h1>
          <div className="rh-mono rh-text-10 rh-tracking-25 uppercase mt-1" style={{ color: "#A89478" }}>
            always another thread
          </div>
        </div>
        <div className="flex justify-end">
          <div className="flex items-center gap-3">
            {hasStarted && (
              <div className="rh-mono rh-text-10" style={{ color: "#A89478" }}>
                {nodes.length} thought{nodes.length === 1 ? "" : "s"} uncovered
              </div>
            )}
            {/* Real free-trial status (production punch list, Section B) —
                replaces the earlier placeholder tier-zone debug readout
                now that real enforcement exists. Funded accounts aren't
                limited by this at all, so nothing to show them here. */}
            {!funded && (
              <div className="rh-mono rh-text-10" style={{ color: "#6B5B45" }}>
                {trialStatus.searchesUsed}/{trialStatus.searchLimit} free searches today
              </div>
            )}
            <AccountMenu user={user} profile={profile} onProfileChange={setProfile} onProfileRefresh={refreshProfile} />
          </div>
        </div>
      </div>

      {!hasStarted && (
        <div className="flex-1 flex flex-col items-center px-6 pt-10 md:pt-16 pb-10 overflow-y-auto">
          <div className="max-w-md w-full text-center rh-fade-in">
            <h2 className="rh-display rh-hero-headline italic mb-8" style={{ color: "#F1E6D3" }}>
              Follow any thought
              <br />
              as far as it goes.
            </h2>

            <div className="flex items-center gap-2">
              <input
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleStartClick();
                  }
                }}
                placeholder="octopus cognition, silk road, fermentation…"
                disabled={rootLoading}
                className="rh-body flex-1 border outline-none rh-placeholder rh-input text-sm rounded-full px-5 py-3 transition-colors"
                style={{ backgroundColor: "#332617", borderColor: "#5A4630", color: "#F1E6D3" }}
              />
              <button
                type="button"
                onClick={handleStartClick}
                disabled={rootLoading}
                className="rh-body flex items-center gap-1.5 disabled:opacity-40 text-sm font-medium rounded-full px-5 py-3 transition-colors shrink-0 rh-btn-accent"
                style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
              >
                {rootLoading ? (
                  <>
                    <Loader2 size={15} className="animate-spin" /> Digging in…
                  </>
                ) : (
                  <>
                    <Sparkles size={15} /> Dig in
                  </>
                )}
              </button>
            </div>
            {rootError && (
              <div className="mt-4 flex items-center justify-center gap-1.5 text-xs rh-body" style={{ color: "#D98A6E" }}>
                <AlertCircle size={13} /> {rootError}
              </div>
            )}

            {rootLoading && rootPreview && (
              <div className="mt-4 max-w-lg mx-auto text-sm rh-body" style={{ color: "#A89478" }}>
                {rootPreview}
                <span className="rh-cursor-blink" style={{ color: "#E3A73C" }}>
                  {"▌"}
                </span>
              </div>
            )}

            {/* real, live-searched stories — see
                supabase/functions/generate-trending-topics. The "as of"
                date reflects the actual cache timestamp now, not a
                hand-maintained string that can silently go stale.
                Hidden once the free trial's used up (production punch
                list, Section B) — News is a funded-only feature per the
                monetization outline's Section 14.1 feature matrix. */}
            {newsTopics.length > 0 && !trialExhausted && newsVisible && (
              <div className="mt-10">
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
                    In the news
                  </span>
                </div>
                <div className="rh-mono text-sm mb-6" style={{ color: "#A89478" }}>
                  as of{" "}
                  <span className="font-semibold" style={{ color: "#E3A73C" }}>
                    {new Date(newsTopics[0].generated_at).toLocaleDateString(undefined, {
                      month: "long",
                      day: "numeric",
                    })}
                  </span>
                </div>
                <div className="flex flex-col gap-3 max-w-md mx-auto">
                  {newsTopics.map((t, i) => {
                    const isSelected = selectedNewsIdx === i;
                    return (
                      <button
                        key={`${t.field}-${i}`}
                        type="button"
                        onClick={() => {
                          setSelectedNewsIdx(i);
                          setSelectedTodayIdx(null);
                          startTopic(t.topic, t.teaser);
                        }}
                        disabled={rootLoading}
                        className={`rh-chip text-left p-4 rounded-2xl border transition-colors ${
                          rootLoading && !isSelected ? "opacity-40" : ""
                        } ${rootLoading && isSelected ? "cursor-default" : ""}`}
                        style={{
                          borderColor: isSelected ? "#E3A73C" : "#3A2E20",
                          backgroundColor: isSelected ? "#2A2015" : "#1F1811",
                        }}
                      >
                        <span className="rh-mono text-xs uppercase tracking-wider font-semibold" style={{ color: "#E3A73C" }}>
                          {t.field}
                        </span>
                        <div className="rh-body text-lg font-semibold mt-1" style={{ color: "#F1E6D3" }}>
                          {t.topic}
                        </div>
                        <p className="rh-body text-sm mt-1" style={{ color: "#B8A886" }}>
                          {t.teaser}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* "Today" — National Day + This Day In History, same source
                table and card treatment as "In the news" but date-anchored
                rather than searched-for-recency. See promptForField in
                supabase/functions/generate-trending-topics. Same
                funded-only gate as "In the news" above. */}
            {todayTopics.length > 0 && !trialExhausted && todayVisible && (
              <div className="mt-10">
                <div className="flex items-center justify-center gap-1.5 mb-6">
                  <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
                    Today
                  </span>
                </div>
                <div className="flex flex-col gap-3 max-w-md mx-auto">
                  {todayTopics.map((t, i) => {
                    const isSelected = selectedTodayIdx === i;
                    return (
                      <button
                        key={`${t.field}-${i}`}
                        type="button"
                        onClick={() => {
                          setSelectedTodayIdx(i);
                          setSelectedNewsIdx(null);
                          startTopic(t.topic, t.teaser);
                        }}
                        disabled={rootLoading}
                        className={`rh-chip text-left p-4 rounded-2xl border transition-colors ${
                          rootLoading && !isSelected ? "opacity-40" : ""
                        } ${rootLoading && isSelected ? "cursor-default" : ""}`}
                        style={{
                          borderColor: isSelected ? "#E3A73C" : "#3A2E20",
                          backgroundColor: isSelected ? "#2A2015" : "#1F1811",
                        }}
                      >
                        <span className="rh-mono text-xs uppercase tracking-wider font-semibold" style={{ color: "#E3A73C" }}>
                          {t.field}
                        </span>
                        <div className="rh-body text-lg font-semibold mt-1" style={{ color: "#F1E6D3" }}>
                          {t.topic}
                        </div>
                        <p className="rh-body text-sm mt-1" style={{ color: "#B8A886" }}>
                          {t.teaser}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Free trial used up (production punch list, Section B) — the
                "hero placement promoting the paid balance" the
                monetization outline's Section 14.1 calls for once the
                floor is hit. Billing (Section D) is live now, so this
                points at the real "Manage" > "Add funds" control in
                AccountMenu above instead of a dead-end CTA. */}
            {trialExhausted && (
              <div className="mt-10 p-4 rounded-2xl border text-center" style={{ borderColor: "#3A2E20", backgroundColor: "#1F1811" }}>
                <div className="text-base font-semibold mb-1" style={{ color: "#F1E6D3" }}>
                  Free searches used up for today
                </div>
                <p className="rh-body text-sm" style={{ color: "#B8A886" }}>
                  Dig In still works — explore new topics any time. Branches, articles, and news reset in 24h, or{" "}
                  {user ? "add funds above for full access now." : "sign in above to add funds for full access now."}
                </p>
              </div>
            )}

            {/* Ad (mockup) — bottom of the landing hero, below "In the news" */}
            <div className="mt-8 p-4 rounded-2xl border text-left" style={{ borderColor: "#3A2E20", backgroundColor: "#1F1811" }}>
              <span
                className="rh-mono rh-text-10 uppercase tracking-wider px-2 py-0.5 rounded-full inline-block mb-2"
                style={{ color: "#14100C", backgroundColor: "#E3A73C" }}
              >
                Sponsored · {MOCK_SPONSOR.landing.brand}
              </span>
              <div className="text-base font-semibold mb-1" style={{ color: "#F1E6D3" }}>
                {MOCK_SPONSOR.landing.headline}
              </div>
              <p className="text-sm mb-3" style={{ color: "#B8A886" }}>
                {MOCK_SPONSOR.landing.description}
              </p>
              <button
                type="button"
                className="flex items-center gap-1.5 text-sm font-medium transition-colors rh-link-accent"
                style={{ color: "#E3A73C" }}
              >
                {MOCK_SPONSOR.landing.cta} <ArrowUpRight size={14} />
              </button>
            </div>

            <div className="mt-10 flex items-center justify-center gap-4 rh-mono rh-text-10" style={{ color: "#5A4A38" }}>
              <button
                type="button"
                onClick={() => setLegalDoc("terms")}
                className="rh-link-accent transition-colors"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit" }}
              >
                Terms
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => setLegalDoc("privacy")}
                className="rh-link-accent transition-colors"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit" }}
              >
                Privacy
              </button>
            </div>
          </div>
        </div>
      )}

      {legalDoc && <LegalModal doc={legalDoc} onClose={() => setLegalDoc(null)} />}

      {hasStarted && selected && (
        <>
          <div ref={contentRef} className="flex-1 overflow-y-auto px-5 md:px-7 pb-10">
            <div className="max-w-2xl mx-auto rh-fade-in" key={selected.id}>
              <span
                className="rh-mono rh-text-10 uppercase tracking-wider px-2 py-0.5 rounded-full inline-block mb-3"
                style={{
                  color: TYPE_COLOR[selected.type] || "#E3A73C",
                  border: `1px solid ${TYPE_COLOR[selected.type] || "#E3A73C"}55`,
                }}
              >
                {selected.type === "root" ? "Origin" : TYPE_LABEL[selected.type]}
              </span>

              <h2 className="rh-display text-3xl italic mb-4" style={{ color: "#F1E6D3" }}>
                {selected.label}
              </h2>

              <div ref={articleTextRef} className="text-base leading-relaxed" style={{ color: "#F5EDDC" }}>
                {childPreview && childPreview.nodeId === selected.id ? (
                  <p>
                    {childPreview.text}
                    <span className="rh-cursor-blink" style={{ color: "#E3A73C" }}>
                      {"▌"}
                    </span>
                  </p>
                ) : (selected.type === "root" ? selected.overview || selected.teaser : selected.teaser) ? (
                  <p>{renderLinked(selected.type === "root" ? selected.overview || selected.teaser : selected.teaser, selectedChildren)}</p>
                ) : null}

                {selected.article ? (
                  <div className="mt-4 pt-4 border-t space-y-4" style={{ borderColor: "#4A3C2C", color: "#F1E6D3" }}>
                    {selected.article
                      .split(/\n\s*\n/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                      .map((para, i, arr) => (
                        <Fragment key={i}>
                          <p>
                            {renderLinked(para, selectedChildren)}
                            {selected.articleStreaming && i === arr.length - 1 ? (
                              <span className="rh-cursor-blink" style={{ color: "#E3A73C" }}>
                                {"▌"}
                              </span>
                            ) : null}
                          </p>
                          {/* Ad tier 1 (mockup) — hero placement. Was
                              root-only; branch nodes are where most of a
                              session's actual page views happen once
                              someone starts exploring outward, so this
                              tier now shows on every node's article, not
                              just the root's. Sandwiched between the
                              article's first two paragraphs rather than
                              sitting above the article entirely. */}
                          {!selected.articleStreaming && i === 0 && arr.length > 1 && (
                            <div className="p-4 rounded-2xl border" style={{ borderColor: "#3A2E20", backgroundColor: "#1F1811" }}>
                              <span
                                className="rh-mono rh-text-10 uppercase tracking-wider px-2 py-0.5 rounded-full inline-block mb-2"
                                style={{ color: "#E3A73C", border: "1px solid #E3A73C55" }}
                              >
                                Sponsored · {MOCK_SPONSOR.tier1.brand}
                              </span>
                              <div className="text-base font-semibold mb-1" style={{ color: "#F1E6D3" }}>
                                {MOCK_SPONSOR.tier1.headline}
                              </div>
                              <p className="text-sm mb-3" style={{ color: "#B8A886" }}>
                                {MOCK_SPONSOR.tier1.description}
                              </p>
                              <button
                                type="button"
                                className="flex items-center gap-1.5 text-sm font-medium transition-colors rh-link-accent"
                                style={{ color: "#E3A73C" }}
                              >
                                {MOCK_SPONSOR.tier1.cta} <ArrowUpRight size={14} />
                              </button>
                            </div>
                          )}
                          {/* Ad tier 2 (mockup) — inline rest card, one quiet
                              pause partway through, only once the article has
                              fully landed */}
                          {!selected.articleStreaming && i === 1 && arr.length > 2 && (
                            <div className="p-4 rounded-2xl border" style={{ borderColor: "#3A2E20", backgroundColor: "#1F1811" }}>
                              <span className="rh-mono rh-text-10 uppercase tracking-wider" style={{ color: "#E3A73C" }}>
                                Sponsored · {MOCK_SPONSOR.tier2.brand}
                              </span>
                              <p className="text-sm mt-1 mb-2" style={{ color: "#B8A886" }}>{MOCK_SPONSOR.tier2.text}</p>
                              <button
                                type="button"
                                className="flex items-center gap-1.5 text-sm font-medium transition-colors rh-link-accent"
                                style={{ color: "#E3A73C" }}
                              >
                                {MOCK_SPONSOR.tier2.cta} <ArrowUpRight size={13} />
                              </button>
                            </div>
                          )}
                        </Fragment>
                      ))}

                    {/* light-touch, not a primary action — this app is
                        entertainment, not a research tool, so this is
                        deliberately understated and capped to one extra
                        round (selected.deepened) rather than open-ended
                        pagination for the minority who want a bit more
                        before moving on */}
                    {!selected.articleStreaming && !selected.articleLoading && !selected.deepened && !trialExhausted && digDeeperVisible && (
                      <button
                        onClick={() => deepenArticle(selected.id)}
                        className="flex items-center gap-1.5 text-sm font-medium transition-colors rh-link-accent"
                        style={{ color: "#A89478" }}
                      >
                        <ChevronDown size={15} /> Dig deeper
                      </button>
                    )}
                    {selected.deepenError && (
                      <div className="flex items-center gap-1.5 text-sm" style={{ color: "#D98A6E" }}>
                        <AlertCircle size={13} /> {selected.deepenError}
                      </div>
                    )}
                  </div>
                ) : selected.articleLoading ? (
                  <div className="mt-4 flex items-center gap-1.5 text-base" style={{ color: "#B8A886" }}>
                    <Loader2 size={16} className="animate-spin" /> Loading more…
                  </div>
                ) : selected.articleError ? (
                  <div className="mt-4">
                    <button
                      onClick={() => loadArticle(selected.id)}
                      className="flex items-center gap-1.5 text-base font-medium transition-colors rh-link-accent"
                      style={{ color: "#E3A73C" }}
                    >
                      <BookOpen size={16} /> Try again
                    </button>
                    <div className="flex items-center gap-1.5 text-sm mt-2" style={{ color: "#D98A6E" }}>
                      <AlertCircle size={13} /> {selected.articleError}
                    </div>
                  </div>
                ) : null}

                {selected.error && (
                  <div className="flex items-center gap-1.5 text-sm mt-3" style={{ color: "#D98A6E" }}>
                    <AlertCircle size={13} /> {selected.error}
                  </div>
                )}
                {selected.loading && (
                  <div className="flex items-center gap-1.5 text-base mt-3" style={{ color: "#B8A886" }}>
                    <Loader2 size={16} className="animate-spin" /> Digging in…
                  </div>
                )}
                {selected.error && !selected.loading && (
                  <button
                    onClick={() => expandNode(selected.id)}
                    className="mt-2 flex items-center gap-1.5 text-base font-medium transition-colors rh-link-accent"
                    style={{ color: "#E3A73C" }}
                  >
                    <ArrowUpRight size={14} /> Try again
                  </button>
                )}
              </div>

              {/* deliberately OUTSIDE articleTextRef — chip labels and the
                  reset button aren't article prose, and highlighting one of
                  them shouldn't be treated as "explore this word" the way
                  selecting actual article text is meant to be */}
              <div>
                {/* breadcrumb — every earlier stop is tappable, jumps
                    straight back with no need to retrace taps one at a
                    time. Sits right above "Explore next" now, inline, as a
                    "here's how you got here" just before "here's where you
                    can go" instead of pinned above the article itself. */}
                <div className="flex items-center gap-1.5 flex-wrap rh-body text-xs mt-10 mb-4">
                  {breadcrumb.map((n, i) => (
                    <span key={n.id} className="flex items-center gap-1.5">
                      {i > 0 && <ChevronRight size={10} style={{ color: "#6B5B45" }} aria-hidden="true" />}
                      {i === breadcrumb.length - 1 ? (
                        <span style={{ color: "#F1E6D3", fontWeight: 500 }}>{n.label}</span>
                      ) : (
                        <button
                          onClick={() => jumpToNode(n.id)}
                          className="rh-crumb transition-colors"
                          style={{ color: "#A89478", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: "2px" }}
                        >
                          {n.label}
                        </button>
                      )}
                    </span>
                  ))}
                </div>

                {/* explore next — pronounced, tappable chips instead of a
                    plain underlined-text list, colored the same way nodes
                    used to be so the branch type is still legible at a
                    glance. A chip with a filled tint has already been
                    opened; an outlined one hasn't. */}
                {selectedChildren.length > 0 && (
                  <div className="mt-6 pt-4 border-t" style={{ borderColor: "#4A3C2C" }}>
                    <div className="rh-mono rh-text-10 uppercase tracking-wider mb-3" style={{ color: "#A89478" }}>
                      Explore next
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {selectedChildren.map((child) => {
                        const color = "#E3A73C"; // same bright orange for every chip, regardless of branch type
                        const visited = !!child.article;
                        return (
                          <button
                            key={child.id}
                            onClick={() => jumpToNode(child.id)}
                            className="rh-chip rh-body text-sm rounded-full px-4 py-2 border transition-colors"
                            style={{
                              borderColor: color,
                              color,
                              backgroundColor: visited ? `${color}22` : "transparent",
                            }}
                          >
                            {child.label}
                          </button>
                        );
                      })}
                      {/* Ad tier 3 (mockup) — lightest unit, mixed into the
                          branch chips with just a label, no teaser copy */}
                      <button
                        type="button"
                        className="rh-chip rh-body text-sm rounded-full px-4 py-2 border transition-colors inline-flex items-center gap-1.5"
                        style={{ borderColor: "#5A4C38", color: "#A89478", backgroundColor: "transparent" }}
                      >
                        <span className="rh-mono uppercase" style={{ fontSize: "8px", color: "#E3A73C" }}>
                          Sponsored
                        </span>
                        · {MOCK_SPONSOR.tier3.label} — {MOCK_SPONSOR.tier3.brand}
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-6 pt-4 border-t" style={{ borderColor: "#4A3C2C" }}>
                  <button
                    onClick={reset}
                    className="flex items-center gap-1.5 rh-body text-xs border rounded-full px-3 py-1.5 transition-colors rh-btn-dark"
                    style={{ color: "#F1E6D3", backgroundColor: "#1F1811", borderColor: "#3A2E20" }}
                  >
                    <RotateCcw size={12} />
                    New thread
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* floats just BELOW whatever's currently highlighted in the article
          text, deliberately not above it — the browser's own native
          Copy/Look Up menu appears above a selection on most platforms, so
          sitting below avoids fighting that for the same space. Styled
          identically to the main "Dig in" button (same icon, same label,
          same color) rather than a differently-worded "Explore" affordance,
          so it reads as the same app action wherever it shows up instead of
          looking like a piece of browser UI. */}
      {selectionInfo && (
        <button
          type="button"
          onClick={exploreSelection}
          className="rh-body flex items-center gap-1.5 text-sm font-medium rounded-full px-5 py-3 transition-colors shadow-lg rh-btn-accent"
          style={{
            position: "fixed",
            top: selectionInfo.bottom + 14,
            left: selectionInfo.left,
            transform: "translateX(-50%)",
            backgroundColor: "#E3A73C",
            color: "#14100C",
            zIndex: 50,
            whiteSpace: "nowrap",
          }}
        >
          <Sparkles size={15} /> Dig in
        </button>
      )}
    </div>
  );
}
