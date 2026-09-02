// All calls to Claude go through a backend proxy (a Supabase Edge Function)
// instead of hitting api.anthropic.com directly from the browser. The old
// claude.ai-artifact version could call Anthropic unauthenticated because
// that environment handled auth invisibly — that doesn't exist once this
// app is deployed on its own, and the real Anthropic key must never sit in
// client-side code. See supabase/functions/rabbit-hole-proxy for the server
// side of this and the handoff README for the Phase 1/2 plan this sets up.
import { getSessionId } from "./session.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const PROXY_URL = `${SUPABASE_URL}/functions/v1/rabbit-hole-proxy`;

function proxyHeaders() {
  return {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

// Wraps the fixed instruction/tone text (src/lib/hyphaSystemPrompt.js) in
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

// Phase 1 of the tiered-usage design (see tierConfig.js): the proxy already
// computes this session's rolling 24h action count for the existing daily
// safety cap, and now echoes it back as a response header instead of
// keeping it server-side-only. Stashed here rather than threaded through
// every call's return value — callClaude/streamJSON/streamTextFromPrompt
// all have different return shapes already, and this is a supplementary
// read, not something any of them need to make a decision on themselves.
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

// Shared fetch + timeout + error-surfacing logic, returning the raw text
// content from Claude's response. callClaude (JSON mode) and article
// fetching (plain prose) both build on this instead of duplicating it.
//
// `endpoint` is a short label (e.g. "root", "expand", "article",
// "continuation") the proxy logs alongside an anonymous session id per
// request — see the handoff brief's Phase 1 logging note: this is what lets
// Phase 2's usage caps be set from real numbers instead of a guess.
async function fetchClaudeText(system, prompt, maxTokens, endpoint) {
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
      }),
      signal: controller.signal,
    });
  } catch (networkErr) {
    if (networkErr.name === "AbortError") {
      throw new Error("Request timed out after 25s — no response from the API.");
    }
    console.error("Hypha: network error calling Claude", networkErr);
    throw new Error(`Network error: ${networkErr.message || "fetch failed"}`);
  } finally {
    clearTimeout(timeoutId);
  }

  captureActionsToday(res);

  if (!res.ok) {
    let bodySnippet = "";
    try {
      bodySnippet = (await res.text()).slice(0, 200);
    } catch (_) {}
    console.error("Hypha: API returned non-OK status", res.status, bodySnippet);
    throw new Error(`API returned ${res.status}${bodySnippet ? `: ${bodySnippet}` : ""}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) {
    console.error("Hypha: no text content in API response", data);
    throw new Error("Empty response from the API.");
  }
  return text;
}

export async function callClaude(system, prompt, endpoint) {
  const text = await fetchClaudeText(system, prompt, undefined, endpoint);
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    console.error("Hypha: couldn't find JSON in response text", text);
    throw new Error("Couldn't parse the API's response.");
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (parseErr) {
    console.error("Hypha: JSON parse failed", parseErr, cleaned);
    throw new Error("Couldn't parse the API's response.");
  }
}

// Shared streaming core: opens the request with stream:true, parses the
// API's server-sent-event chunks, and calls onChunk with the accumulated
// text so far after every delta. Returns the final raw accumulated text —
// callers apply their own cleanup/parsing on top (plain prose vs. JSON).
async function streamRaw(system, prompt, maxTokens, timeoutMs, endpoint, onChunk, newsCacheKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
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
        ...(newsCacheKey ? { newsCacheKey } : {}),
      }),
      signal: controller.signal,
    });
  } catch (networkErr) {
    clearTimeout(timeoutId);
    if (networkErr.name === "AbortError") {
      throw new Error("Request timed out — no response from the API.");
    }
    console.error("Hypha: network error streaming", networkErr);
    throw new Error(`Network error: ${networkErr.message || "fetch failed"}`);
  }

  captureActionsToday(res);

  if (!res.ok) {
    clearTimeout(timeoutId);
    let bodySnippet = "";
    try {
      bodySnippet = (await res.text()).slice(0, 200);
    } catch (_) {}
    console.error("Hypha: stream returned non-OK status", res.status, bodySnippet);
    throw new Error(`API returned ${res.status}${bodySnippet ? `: ${bodySnippet}` : ""}`);
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
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let gotAnyData = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      gotAnyData = true;
      clearTimeout(timeoutId);
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
        } else if (evt.type === "error") {
          throw new Error(evt.error?.message || "The API reported a streaming error.");
        }
      }
    }
  } catch (streamErr) {
    console.error("Hypha: stream failed", streamErr);
    if (!gotAnyData) throw streamErr;
    // if we already streamed in some real text before failing, keep it rather
    // than throwing the whole thing away — partial content is still useful
  } finally {
    clearTimeout(timeoutId);
  }

  return fullText;
}

// "Read more" content: real prose, not JSON, so no parsing needed beyond
// trimming stray markdown fences a model might add out of habit.
export async function streamTextFromPrompt(system, prompt, maxTokens, timeoutMs, endpoint, onChunk) {
  const fullText = await streamRaw(system, prompt, maxTokens, timeoutMs, endpoint, onChunk);
  return fullText.replace(/```/g, "").trim();
}

// Matches an in-progress `"overview": "..."` field in a partially-streamed
// JSON blob — captures everything after the opening quote, including a
// string that hasn't been closed yet, so the overview can be shown as it's
// written rather than only once the whole response (children included)
// has finished generating.
const OVERVIEW_PATTERN = /"overview"\s*:\s*"((?:[^"\\]|\\.)*)/;
const JSON_ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

// Best-effort unescape for a JSON string fragment that may end mid-escape
// (the stream hasn't delivered the rest yet) — not run through JSON.parse
// since it isn't necessarily valid/complete JSON yet.
function unescapeJSONStringFragment(s) {
  return s.replace(/\\(["\\/bfnrt])/g, (_, c) => JSON_ESCAPES[c]);
}

// Same contract as callClaude (streams instead of waiting for the whole
// response), plus an optional onOverviewChunk callback fired with the
// "overview" field's text as it streams in — the one field worth showing
// live while the rest of the JSON (children, etc.) is still generating.
export async function streamJSON(system, prompt, endpoint, onOverviewChunk, newsCacheKey) {
  const fullText = await streamRaw(
    system,
    prompt,
    1200,
    25000,
    endpoint,
    (partial) => {
      if (!onOverviewChunk) return;
      const match = partial.match(OVERVIEW_PATTERN);
      if (match) onOverviewChunk(unescapeJSONStringFragment(match[1]));
    },
    newsCacheKey
  );
  const cleaned = fullText.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    console.error("Hypha: couldn't find JSON in streamed response", fullText);
    throw new Error("Couldn't parse the API's response.");
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (parseErr) {
    console.error("Hypha: JSON parse failed", parseErr, cleaned);
    throw new Error("Couldn't parse the API's response.");
  }
}

// Fire-and-forget: tells the proxy to cache a root response for a
// news/today topic so the next visitor to open the same card is served
// this instead of triggering another generation. Called from App.jsx only
// after a news-context root call has already finished streaming — kept as
// its own request rather than something the generation call itself does,
// so the generation always streams normally (see rabbit-hole-proxy for why
// combining the two added visible latency on every cache miss). Errors are
// swallowed: a failed cache write just means the next visitor generates
// fresh too, never worth surfacing to the person who already got their
// answer.
export function writeNewsRootCache(cacheKey, rootLabel, overview, children) {
  fetch(PROXY_URL, {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify({ newsCacheWrite: { cacheKey, rootLabel, overview, children } }),
  }).catch((e) => console.error("Hypha: failed to write news root cache", e));
}
