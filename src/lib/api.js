// All calls to Claude go through a backend proxy (a Supabase Edge Function)
// instead of hitting api.anthropic.com directly from the browser. The old
// claude.ai-artifact version could call Anthropic unauthenticated because
// that environment handled auth invisibly — that doesn't exist once this
// app is deployed on its own, and the real Anthropic key must never sit in
// client-side code. See supabase/functions/rabbit-hole-proxy for the server
// side of this and the handoff README for the Phase 1/2 plan this sets up.
import { getSessionId } from "./session.js";
import { getAccessToken } from "./auth.js";
import { getAttribution } from "./attribution.js";
import { getVisitorId, touchSession, isTestMode } from "./visitor.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
// Points at "rabbit-hole-proxy-v2", not the original "rabbit-hole-proxy" —
// the original function's registration on Supabase's edge network got
// stuck rejecting every single request (even an unauthenticated CORS
// preflight OPTIONS) with a platform-level 401, regardless of code changes
// or the function's own JWT-enforcement setting. A fresh function under a
// new name, same code, sidesteps whatever's wrong with that specific slug
// without waiting on Supabase support to un-stick it.
const PROXY_URL = `${SUPABASE_URL}/functions/v1/rabbit-hole-proxy-v2`;

function proxyHeaders() {
  return {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

// Wraps the fixed instruction/tone text (src/lib/hyfaxSystemPrompt.js) in
// the shape the proxy/Anthropic expect, with a prompt-caching breakpoint on
// it — see the proxy for how this gets forwarded. 1h TTL rather than the
// 5-minute default: this app's real traffic is spread-out, occasional
// requests across a browsing session (and across different people sharing
// the link) rather than a tight burst, so the longer-lived cache entry is
// far more likely to still be warm by the time the next request comes in.
function systemBlock(system) {
  if (!system) return undefined;
  return [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }];
}

// The proxy computes this session's rolling 24h action count for the
// existing daily safety cap, and echoes it back as a response header
// instead of keeping it server-side-only. Stashed here rather than
// threaded through every call's return value — callClaude and
// streamTextFromPrompt have different return shapes already, and this
// is a supplementary read, not something any of them need to decide on.
let lastActionsToday = null;
export function getLastActionsToday() {
  return lastActionsToday;
}
function captureActionsToday(res) {
  const raw = res.headers.get("X-Session-Actions-Today");
  if (raw == null) return;
  const n = Number(raw);
  if (!Number.isNaN(n)) lastActionsToday = n;
}

// Section B of the production punch list (free-tier enforcement): the
// proxy computes real trial status server-side (searches used, the limit,
// whether this caller is funded) and echoes it back the same way as
// getLastActionsToday above, so the UI can proactively hide/disable
// News/Today/Dig Deeper once the trial's used up instead of only finding
// out from a failed request.
let lastTrialStatus = null;
export function getLastTrialStatus() {
  return lastTrialStatus;
}
function captureTrialStatus(res) {
  const used = res.headers.get("X-Trial-Searches-Used");
  const limit = res.headers.get("X-Trial-Search-Limit");
  const funded = res.headers.get("X-Trial-Funded");
  if (used == null || limit == null) return;
  const searchesUsed = Number(used);
  const searchLimit = Number(limit);
  if (Number.isNaN(searchesUsed) || Number.isNaN(searchLimit)) return;
  lastTrialStatus = { searchesUsed, searchLimit, funded: funded === "1" };
}

// Thrown when the proxy rejects a call because the free trial's search
// allowance is used up and this identity isn't funded — App.jsx catches
// this specifically to show an upgrade message instead of a generic error.
export class TrialExhaustedError extends Error {
  constructor(message) {
    super(message || "Free trial searches used up for today.");
    this.name = "TrialExhaustedError";
  }
}

// Auth token for the CURRENT signed-in user, if any — sent alongside the
// existing anonymous session id so the proxy can verify who's really
// calling (never trust a client-supplied user id) and count a signed-in
// user's trial searches against their real account instead of their
// browser's resettable session_id. Anonymous visitors just don't have one;
// every existing call keeps working unchanged.
async function authField() {
  const token = await getAccessToken();
  return token ? { userAccessToken: token } : {};
}

// The visitor's own IANA timezone (e.g. "America/Los_Angeles"), so the
// proxy's free-trial "reset at 3am" cutoff lands at 3am THEIR local time
// instead of one fixed timezone for everyone — see rabbit-hole-proxy's
// trialDayStartIso. Every modern browser exposes this; the try/catch is
// only for the very rare environment that doesn't, in which case the
// proxy falls back to America/New_York on its own.
function timeZoneField() {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone ? { timeZone } : {};
  } catch {
    return {};
  }
}

// Shared fetch + timeout + error-surfacing logic, returning the raw text
// content from Claude's response. callClaude (JSON mode) and article
// fetching (plain prose) both build on this instead of duplicating it.
//
// `endpoint` is a short label (e.g. "root", "expand", "article",
// "continuation") the proxy logs alongside an anonymous session id per
// request — see the handoff brief's Phase 1 logging note: this is what lets
// Phase 2's usage caps be set from real numbers instead of a guess.
async function fetchClaudeText(system, prompt, maxTokens, endpoint, nodeCacheKey, newsCacheKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  let res;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: proxyHeaders(),
      body: JSON.stringify({
        max_tokens: maxTokens || 1200,
        system: systemBlock(system),
        messages: [{ role: "user", content: prompt }],
        endpoint,
        sessionId: getSessionId(),
        // Branch-node cache key (see App.jsx's expandNode) — only ever set
        // for a "expand" call on a direct child of an already-cached root,
        // same idea as streamRaw's newsCacheKey but one level deeper (see
        // rabbit-hole-proxy-v2's node_cache table).
        ...(nodeCacheKey ? { nodeCacheKey } : {}),
        // A cached topic's own chips (see App.jsx's expandNode) — read from
        // that topic's news_root_cache row instead of generated per visitor.
        ...(newsCacheKey ? { newsCacheKey } : {}),
        ...(await authField()),
        ...timeZoneField(),
      }),
      signal: controller.signal,
    });
  } catch (networkErr) {
    if (networkErr.name === "AbortError") {
      throw new Error("Request timed out after 25s — no response from the API.");
    }
    console.error("Hyfax: network error calling Claude", networkErr);
    throw new Error(`Network error: ${networkErr.message || "fetch failed"}`);
  } finally {
    clearTimeout(timeoutId);
  }

  captureActionsToday(res);
  captureTrialStatus(res);

  if (res.status === 402) {
    let message;
    try {
      message = (await res.json()).message;
    } catch (_) {}
    throw new TrialExhaustedError(message);
  }

  if (!res.ok) {
    let bodySnippet = "";
    let friendlyMessage = null;
    try {
      bodySnippet = (await res.text()).slice(0, 200);
      friendlyMessage = JSON.parse(bodySnippet)?.message || null;
    } catch (_) {}
    console.error("Hyfax: API returned non-OK status", res.status, bodySnippet);
    throw new Error(friendlyMessage || `API returned ${res.status}${bodySnippet ? `: ${bodySnippet}` : ""}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) {
    console.error("Hyfax: no text content in API response", data);
    throw new Error("Empty response from the API.");
  }
  return { text, usage: data.usage || null };
}

// `onUsage`, when given, is called with this call's real {input_tokens,
// output_tokens} — only meaningful for a genuinely fresh generation (a
// cache hit's usage is always zeroed, see rabbit-hole-proxy-v2). Lets
// expandNode capture a branch's real cost in the SAME request that writes
// its node_cache row (see writeNodeCache), avoiding a race against the
// server's own background billing task the way root's rootUsage already
// does for its own cache write.
export async function callClaude(system, prompt, endpoint, nodeCacheKey, onUsage, newsCacheKey) {
  const { text, usage } = await fetchClaudeText(system, prompt, undefined, endpoint, nodeCacheKey, newsCacheKey);
  if (onUsage) onUsage(usage);
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    console.error("Hyfax: couldn't find JSON in response text", text);
    throw new Error("Couldn't parse the API's response.");
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (parseErr) {
    console.error("Hyfax: JSON parse failed", parseErr, cleaned);
    throw new Error("Couldn't parse the API's response.");
  }
}

// Shared streaming core: opens the request with stream:true, parses the
// API's server-sent-event chunks, and calls onChunk with the accumulated
// text so far after every delta. Returns the final raw accumulated text —
// callers apply their own cleanup/parsing on top (plain prose vs. JSON).
async function streamRaw(system, prompt, maxTokens, timeoutMs, endpoint, onChunk, newsCacheKey, nodeCacheKey, nodeType, onUsage, heroSource) {
  const controller = new AbortController();
  let timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: proxyHeaders(),
      body: JSON.stringify({
        max_tokens: maxTokens,
        stream: true,
        system: systemBlock(system),
        messages: [{ role: "user", content: prompt }],
        endpoint,
        sessionId: getSessionId(),
        // Adoption analytics identity (see lib/visitor.js + migration 0049)
        // — a SEPARATE id from sessionId above (that one's the long-lived
        // free-trial rate-limit id and never expires; this one resets after
        // a 30-minute gap). Attached to every call, same as the
        // attribution fields below, so the proxy can log an article_view
        // event server-side (see rabbit-hole-proxy-v2's logRequest) without
        // a second, separate client round-trip for every article.
        visitorId: getVisitorId(),
        visitorSessionId: touchSession().sessionId,
        isTest: isTestMode(),
        ...(newsCacheKey ? { newsCacheKey } : {}),
        // Branch-node equivalent of newsCacheKey, one level deeper — only
        // ever set for a branch's own article (see App.jsx's loadArticle),
        // never alongside newsCacheKey (mutually exclusive by construction).
        ...(nodeCacheKey ? { nodeCacheKey } : {}),
        ...(nodeType ? { nodeType } : {}),
        // Which hero-page section (or freeform/spin-a-thread/shared-link)
        // led to this ROOT call — see App.jsx's startTopic. Analytics only,
        // logged onto rabbit_hole_request_logs so the admin dashboard can
        // show what people actually click into from the hero page.
        ...(heroSource ? { heroSource } : {}),
        // Ad-attribution signals (see lib/attribution.js) — attached to
        // EVERY request, not just root, so a full session's cost/behavior
        // can be traced back to its source, not just the one call that
        // happened to carry the URL params.
        ...(() => {
          const attr = getAttribution();
          return {
            ...(attr.utmSource ? { utmSource: attr.utmSource } : {}),
            ...(attr.utmCampaign ? { utmCampaign: attr.utmCampaign } : {}),
            ...(attr.utmContent ? { utmContent: attr.utmContent } : {}),
            ...(attr.rdtCid ? { rdtCid: attr.rdtCid } : {}),
          };
        })(),
        ...(await authField()),
        ...timeZoneField(),
      }),
      signal: controller.signal,
    });
  } catch (networkErr) {
    clearTimeout(timeoutId);
    if (networkErr.name === "AbortError") {
      throw new Error("Request timed out — no response from the API.");
    }
    console.error("Hyfax: network error streaming", networkErr);
    throw new Error(`Network error: ${networkErr.message || "fetch failed"}`);
  }

  captureActionsToday(res);
  captureTrialStatus(res);

  if (res.status === 402) {
    clearTimeout(timeoutId);
    let message;
    try {
      message = (await res.json()).message;
    } catch (_) {}
    throw new TrialExhaustedError(message);
  }

  if (!res.ok) {
    clearTimeout(timeoutId);
    let bodySnippet = "";
    let friendlyMessage = null;
    try {
      bodySnippet = (await res.text()).slice(0, 200);
      friendlyMessage = JSON.parse(bodySnippet)?.message || null;
    } catch (_) {}
    console.error("Hyfax: stream returned non-OK status", res.status, bodySnippet);
    throw new Error(friendlyMessage || `API returned ${res.status}${bodySnippet ? `: ${bodySnippet}` : ""}`);
  }

  // A `newsCacheKey` cache HIT comes back as one complete JSON object
  // (Content-Type: application/json), not an SSE stream — this always
  // requests stream:true, so that's the one case where the server's
  // response shape doesn't match what was asked for. Handle it the same
  // way as the "environment doesn't support streaming" fallback: read it
  // as a whole and hand it to onChunk once, rather than feeding it through
  // the SSE line-parser below where it would never match a "data:" line.
  const contentType = res.headers.get("Content-Type") || "";
  if (!res.body || !res.body.getReader || contentType.includes("application/json")) {
    clearTimeout(timeoutId);
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    onChunk(text);
    // A cache-hit response's usage is always zeroed (see rabbit-hole-proxy)
    // — nothing to report, and onUsage only matters for a genuinely fresh
    // generation anyway (see its callers for why: seeding the cache with
    // real cost, not re-reporting a cache hit's already-known zero cost).
    if (onUsage) onUsage(data.usage || null);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let gotAnyData = false;
  // Mirrors rabbit-hole-proxy's own parseSSEUsage — input/cache tokens
  // arrive on message_start, the true final output-token count arrives on
  // the LAST message_delta before the stream ends (each one is a running
  // total, not an increment). Only captured client-side so a root
  // generation's real cost can travel along with its OWN cache write (see
  // writeNewsRootCache's new usage args) — avoids a race against the
  // server's background billing task, which can't reliably attach usage to
  // a news_root_cache row the client hasn't created yet at that point.
  let capturedUsage = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      gotAnyData = true;
      // Re-armed on every chunk, not just cleared once — this bounds the
      // gap between chunks, not just the time to the first one. A stream
      // that produces one chunk and then stalls (server-side hang,
      // network black hole) used to hang here forever, since the timeout
      // was cleared on the first chunk and never reset.
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep the last (possibly incomplete) line for next read
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        let evt;
        try {
          evt = JSON.parse(jsonStr);
        } catch (_) {
          continue;
        }
        if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
          fullText += evt.delta.text;
          onChunk(fullText);
        } else if (evt.type === "message_start" && evt.message?.usage) {
          capturedUsage = { input_tokens: evt.message.usage.input_tokens ?? 0, output_tokens: 0 };
        } else if (evt.type === "message_delta" && evt.usage) {
          capturedUsage = { ...(capturedUsage || { input_tokens: 0 }), output_tokens: evt.usage.output_tokens ?? 0 };
        } else if (evt.type === "error") {
          throw new Error(evt.error?.message || "The API reported a streaming error.");
        }
      }
    }
  } catch (streamErr) {
    console.error("Hyfax: stream failed", streamErr);
    if (!gotAnyData) throw streamErr;
    // if we already streamed in some real text before failing, keep it rather
    // than throwing the whole thing away — partial content is still useful
  } finally {
    clearTimeout(timeoutId);
  }

  if (onUsage) onUsage(capturedUsage);
  return fullText;
}

// "Read more" content: real prose, not JSON, so no parsing needed beyond
// trimming stray markdown fences a model might add out of habit.
//
// `nodeType` (direct/indirect/tangent/custom/root) is logged alongside this
// request purely for analysis — which branch types people actually choose
// to read, so the obscurity mix (hyfaxSystemPrompt.js's OBSCURITY_LEVELS)
// can eventually be tuned toward what resonates instead of a guess.
export async function streamTextFromPrompt(system, prompt, maxTokens, timeoutMs, endpoint, onChunk, nodeType, newsCacheKey, nodeCacheKey, onUsage, heroSource) {
  const fullText = await streamRaw(system, prompt, maxTokens, timeoutMs, endpoint, onChunk, newsCacheKey, nodeCacheKey, nodeType, onUsage, heroSource);
  return fullText.replace(/```/g, "").trim();
}


// Fire-and-forget: caches a cached topic's chips (its indirect/tangent
// threads, generated after its article) on that topic's news_root_cache
// row, so the next visitor to open the same card gets them instantly.
// Creates the row if the article write hasn't yet; otherwise fills in the
// still-empty chips on the row that write made. `usage` is the chip call's
// real cost, so later cache hits can be billed like a fresh generation.
// Errors are swallowed: a failed write just means the next visitor
// generates fresh too.
export function writeNewsRootCache(cacheKey, rootLabel, overview, children, usage) {
  fetch(PROXY_URL, {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify({
      newsCacheWrite: {
        cacheKey,
        rootLabel,
        overview,
        children,
        ...(usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : {}),
      },
    }),
  }).catch((e) => console.error("Hyfax: failed to write news root cache", e));
}

// Same idea as writeNewsRootCache, but for the root's own full article text
// — called from loadArticle in App.jsx only for a news-context ROOT node
// (never a child), once its article has finished streaming. The row this
// updates already exists (created by writeNewsRootCache moments earlier in
// the same visitor's flow); the server-side handler only fills in the
// article column if it's still null, so this is safe to fire even if two
// visitors finish generating around the same time.
// The article now finishes BEFORE the topic's chips exist, so this write
// can be the one that creates the cache row — it carries the title and the
// real usage itself rather than relying on a row the chips write made first.
export function writeNewsArticleCache(cacheKey, article, usage, rootLabel) {
  fetch(PROXY_URL, {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify({
      newsArticleCacheWrite: {
        cacheKey,
        article,
        ...(rootLabel ? { rootLabel } : {}),
        ...(usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : {}),
      },
    }),
  }).catch((e) => console.error("Hyfax: failed to write news article cache", e));
}

// Branch-node equivalent of writeNewsRootCache — see App.jsx's expandNode.
// cacheKey is "<root's own cache key>::<this child's label>" (see
// rabbit-hole-proxy-v2's parseNodeCacheKey); only ever called for a direct
// child of an already-cached root, never a grandchild.
export function writeNodeCache(cacheKey, children, usage) {
  fetch(PROXY_URL, {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify({
      nodeCacheWrite: {
        cacheKey,
        children,
        ...(usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : {}),
      },
    }),
  }).catch((e) => console.error("Hyfax: failed to write node cache", e));
}

// Branch-node equivalent of writeNewsArticleCache — see App.jsx's
// loadArticle. Unlike writeNewsArticleCache, the underlying row may not
// exist yet when this fires (a visitor can open a branch's article without
// ever expanding it), so the server handler creates it here if needed —
// which means, unlike the root article case, usage has to travel in THIS
// same write rather than a later server-side update (nothing guarantees
// the row exists yet for that update to find).
export function writeNodeArticleCache(cacheKey, article, usage) {
  fetch(PROXY_URL, {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify({
      nodeArticleCacheWrite: {
        cacheKey,
        article,
        ...(usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : {}),
      },
    }),
  }).catch((e) => console.error("Hyfax: failed to write node article cache", e));
}
