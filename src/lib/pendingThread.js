// Keeps someone's place across the magic-link sign-in. Tapping "Sign up"
// at the free limit saves the open thread here; the sign-in link opens a
// fresh tab at the home page, which restores it (see App.jsx) so they land
// back on the page they were reading instead of starting over.
// localStorage rather than sessionStorage, since the link opens a new tab.
const KEY = "hyfax-pending-thread";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

// Only what's needed to rebuild the pages — in-flight flags are dropped so
// a page that was mid-load just loads again on restore.
function snapshotNode(n) {
  return {
    id: n.id,
    parentId: n.parentId ?? null,
    label: n.label,
    fullTopic: n.fullTopic,
    teaser: n.teaser || "",
    overview: n.overview || "",
    type: n.type,
    depth: n.depth,
    fromLink: !!n.fromLink,
    pinned: !!n.pinned,
    titled: !!n.titled,
    generated: !!n.generated,
    article: n.articleStreaming || n.articleLoading ? null : n.article || null,
    deepened: !!n.deepened,
    newsContext: n.newsContext || null,
    heroSource: n.heroSource || null,
  };
}

export function savePendingThread(nodes, selectedId, topic) {
  if (!nodes?.length) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), selectedId, topic, nodes: nodes.map(snapshotNode) }));
  } catch {
    // Storage unavailable — they just land on the home page as before.
  }
}

// Returns the saved thread once (and clears it), or null if there isn't a
// recent one.
export function takePendingThread() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const saved = JSON.parse(raw);
    if (!saved?.nodes?.length || Date.now() - saved.savedAt > MAX_AGE_MS) return null;
    return {
      ...saved,
      nodes: saved.nodes.map((n) => ({
        ...n,
        loading: false,
        error: null,
        articleLoading: false,
        articleStreaming: false,
        articleError: null,
        deepenError: null,
        resumed: true,
      })),
    };
  } catch {
    return null;
  }
}
