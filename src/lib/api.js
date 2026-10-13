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

// Ad-attribution signals (see lib/attribution.js), sent with every proxy
// call so a session's cost and behavior trace back to its source.
function attributionFields() {
  const attr = getAttribution();
  return {
    ...(attr.utmSource ? { utmSource: attr.utmSource } : {}),
    ...(attr.utmCampaign ? { utmCampaign: attr.utmCampaign } : {}),
    ...(attr.utmContent ? { utmContent: attr.utmContent } : {}),
    ...(attr.rdtCid ? { rdtCid: attr.rdtCid } : {}),
  };
}

// The body of every Claude call to the proxy. One builder for every kind of
// call, so a field the proxy relies on can't be sent on one and missed on
// another — a thread-card call once lacked utmSource and was held to the
// wrong free-page limit.
//
// `endpoint` is a short label ("article", "expand", "continuation", ...)
// the proxy logs, counts and caches by. The rest:
// - newsCacheKey: a cached topic's key (its article, or its own threads).
// - nodeCacheKey: "<topic>::<thread>", a cached topic's direct thread, one
//   level deeper (rabbit-hole-proxy-v2's node_cache); never sent alongside
//   newsCacheKey.
// - nodeType: the page's thread type (root/direct/indirect/tangent/custom),
//   logged for analysis.
// - heroSource: which hero-page section (or freeform/spin-a-thread/shared
//   link) led to a topic page's call, for /admin.
// - preview: a thread's preview, which doesn't count as a free page (it
//   counts once explored; see claimPage).
// - extra: admin Tone Lab only (e.g. { modelOverride }); the proxy ignores it
//   for anyone not on its ADMIN_USER_IDS list.
async function proxyBody({ system, prompt, maxTokens, stream, endpoint, newsCacheKey, nodeCacheKey, nodeType, heroSource, preview, extra }) {
  return JSON.stringify({
    ...(prompt != null
      ? { max_tokens: maxTokens, system: systemBlock(system), messages: [{ role: "user", content: prompt }] }
      : {}),
    ...(stream ? { stream: true } : {}),
    endpoint,
    ...(preview ? { preview: true } : {}),
    // The long-lived free-limit id; never expires.
    sessionId: getSessionId(),
    // Adoption analytics identity (lib/visitor.js, migration 0049): resets
    // after a 30-minute gap. The proxy logs an article call's article_view
    // with it, so there's no separate client round-trip per page.
    visitorId: getVisitorId(),
    visitorSessionId: touchSession().sessionId,
    // Keeps the operator's own test traffic out of /admin usage.
    isTest: isTestMode(),
    ...(newsCacheKey ? { newsCacheKey } : {}),
    ...(nodeCacheKey ? { nodeCacheKey } : {}),
    ...(nodeType ? { nodeType } : {}),
    ...(heroSource ? { heroSource } : {}),
    // The proxy also sets the free-page limit from utmSource (a Reddit ad
    // visitor gets more).
    ...attributionFields(),
    ...(await authField()),
    ...timeZoneField(),
    ...(extra || {}),
  });
}

// Sends a proxy call and handles what every call shares: network errors and
// timeouts, the usage/trial headers, the free-limit 402 and other error
// statuses. Returns the OK response; `controller` aborts it on timeout.
async function postToProxy(body, controller, onAbandon) {
  let res;
  try {
    res = await fetch(PROXY_URL, { method: "POST", headers: proxyHeaders(), body, signal: controller.signal });
  } catch (networkErr) {
    onAbandon();
    if (networkErr.name === "AbortError") throw new Error("Request timed out — no response from the API.");
    console.error("Hyfax: network error calling the proxy", networkErr);
    throw new Error(`Network error: ${networkErr.message || "fetch failed"}`);
  }

  captureActionsToday(res);
  captureTrialStatus(res);

  if (res.status === 402) {
    onAbandon();
    let message;
    try {
      message = (await res.json()).message;
    } catch (_) {}
    throw new TrialExhaustedError(message);
  }
  if (!res.ok) {
    onAbandon();
    let bodySnippet = "";
    let friendlyMessage = null;
    try {
      bodySnippet = (await res.text()).slice(0, 200);
      friendlyMessage = JSON.parse(bodySnippet)?.message || null;
    } catch (_) {}
    console.error("Hyfax: proxy returned non-OK status", res.status, bodySnippet);
    throw new Error(friendlyMessage || `API returned ${res.status}${bodySnippet ? `: ${bodySnippet}` : ""}`);
  }
  return res;
}

function textOf(data) {
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// A JSON-mode call (a page's threads): waits for the whole response and
// parses the first JSON object in it. `onUsage`, when given, gets this
// call's real {input_tokens, output_tokens} (zeroed on a cache hit), so a
// thread set's real cost can ride along with its own cache write (see
// writeNodeCache) instead of racing the proxy's background billing.
export async function callClaude({ system, prompt, endpoint, nodeCacheKey, newsCacheKey, onUsage }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  let data;
  try {
    const body = await proxyBody({ system, prompt, maxTokens: 1200, endpoint, nodeCacheKey, newsCacheKey });
    const res = await postToProxy(body, controller, () => {});
    data = await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
  const text = textOf(data);
  if (!text) {
    console.error("Hyfax: no text content in API response", data);
    throw new Error("Empty response from the API.");
  }
  if (onUsage) onUsage(data.usage || null);
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

// A streaming call (an article or its continuation): parses the API's
// server-sent events and calls onChunk with the accumulated text after every
// delta (or once, with { whole: true }, when the text arrives complete). Returns the final text, with any stray markdown fences removed.
// `timeoutMs` bounds the wait for the first chunk and every gap after it.
// Takes the same options as proxyBody, plus onChunk, onUsage and timeoutMs.
export async function streamTextFromPrompt({ onChunk, onUsage, timeoutMs, ...request }) {
  const controller = new AbortController();
  let timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const stopTimer = () => clearTimeout(timeoutId);
  const res = await postToProxy(await proxyBody({ ...request, stream: true }), controller, stopTimer);

  // A cache hit comes back as one complete JSON object, not an SSE stream —
  // as does an environment without streaming. Read it whole and hand it to
  // onChunk once. Its usage is zeroed (see rabbit-hole-proxy-v2).
  const contentType = res.headers.get("Content-Type") || "";
  if (!res.body || !res.body.getReader || contentType.includes("application/json")) {
    stopTimer();
    const data = await res.json();
    const text = textOf(data);
    // The whole text at once (a cache hit): `whole` lets the page reveal it
    // as one piece rather than typing it out.
    onChunk(text, { whole: true });
    if (onUsage) onUsage(data.usage || null);
    return text.replace(/```/g, "").trim();
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let gotAnyData = false;
  // Mirrors the proxy's own parseSSEUsage: input tokens arrive on
  // message_start, the final output-token count on the last message_delta
  // (each is a running total). Captured so a generation's real cost can
  // travel with its own cache write (see writeNewsArticleCache).
  let capturedUsage = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      gotAnyData = true;
      // Re-armed on every chunk, so a stream that stalls after its first
      // chunk still times out.
      stopTimer();
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
    // Text that already streamed in is kept rather than thrown away.
  } finally {
    stopTimer();
  }

  if (onUsage) onUsage(capturedUsage);
  return fullText.replace(/```/g, "").trim();
}

// Exploring a thread whose page its preview already loaded: counts that
// page as one of the reader's free pages (no text is fetched). Throws
// TrialExhaustedError if the free pages are already used up.
export async function claimPage({ nodeType, newsCacheKey, nodeCacheKey }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const body = await proxyBody({ endpoint: "article", nodeType, newsCacheKey, nodeCacheKey, extra: { claimPage: true } });
    await postToProxy(body, controller, () => {});
  } finally {
    clearTimeout(timeoutId);
  }
}

// The cache writes below are fire-and-forget: errors are swallowed, since a
// failed write only means the next visitor generates the page fresh too.
// `usage` is the generation's real cost, so later cache hits can be billed
// like a fresh page.
function writeCache(kind, fields, usage) {
  fetch(PROXY_URL, {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify({
      [kind]: { ...fields, ...(usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : {}) },
    }),
  }).catch((e) => console.error(`Hyfax: cache write (${kind}) failed`, e));
}

// A cached topic's threads, on its news_root_cache row (creating the row if
// its article write hasn't yet).
export function writeNewsRootCache(cacheKey, rootLabel, overview, children, usage) {
  writeCache("newsCacheWrite", { cacheKey, rootLabel, overview, children }, usage);
}

// A cached topic's own article — this can be the write that creates the row
// (the article finishes before the threads exist), so it carries the title.
// The server only fills in the article if it's still empty.
export function writeNewsArticleCache(cacheKey, article, usage, rootLabel) {
  writeCache("newsArticleCacheWrite", { cacheKey, article, ...(rootLabel ? { rootLabel } : {}) }, usage);
}

// A cached topic's direct thread's own threads; cacheKey is
// "<topic>::<thread>" (see rabbit-hole-proxy-v2's parseNodeCacheKey).
export function writeNodeCache(cacheKey, children, usage) {
  writeCache("nodeCacheWrite", { cacheKey, children }, usage);
}

// That thread's article; the row may not exist yet (a thread can be read
// without being explored), so the server creates it if needed.
export function writeNodeArticleCache(cacheKey, article, usage) {
  writeCache("nodeArticleCacheWrite", { cacheKey, article }, usage);
}
