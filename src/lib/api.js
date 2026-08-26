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

// Shared fetch + timeout + error-surfacing logic, returning the raw text
// content from Claude's response. callClaude (JSON mode) and article
// fetching (plain prose) both build on this instead of duplicating it.
//
// `endpoint` is a short label (e.g. "root", "expand", "article",
// "continuation") the proxy logs alongside an anonymous session id per
// request — see the handoff brief's Phase 1 logging note: this is what lets
// Phase 2's usage caps be set from real numbers instead of a guess.
async function fetchClaudeText(prompt, maxTokens, endpoint) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  let res;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: proxyHeaders(),
      body: JSON.stringify({
        max_tokens: maxTokens || 1200,
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
    console.error("Rabbit Hole: network error calling Claude", networkErr);
    throw new Error(`Network error: ${networkErr.message || "fetch failed"}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    let bodySnippet = "";
    try {
      bodySnippet = (await res.text()).slice(0, 200);
    } catch (_) {}
    console.error("Rabbit Hole: API returned non-OK status", res.status, bodySnippet);
    throw new Error(`API returned ${res.status}${bodySnippet ? `: ${bodySnippet}` : ""}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text) {
    console.error("Rabbit Hole: no text content in API response", data);
    throw new Error("Empty response from the API.");
  }
  return text;
}

export async function callClaude(prompt, endpoint) {
  const text = await fetchClaudeText(prompt, undefined, endpoint);
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    console.error("Rabbit Hole: couldn't find JSON in response text", text);
    throw new Error("Couldn't parse the API's response.");
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (parseErr) {
    console.error("Rabbit Hole: JSON parse failed", parseErr, cleaned);
    throw new Error("Couldn't parse the API's response.");
  }
}

// "Read more" content: real prose, not JSON, so no parsing needed beyond
// trimming stray markdown fences a model might add out of habit. Streams
// the article as it's generated instead of waiting for the whole thing —
// parses the API's server-sent-event chunks directly and calls onChunk
// with the accumulated text so far after every delta, so the screen can
// render it growing in real time rather than sitting on a spinner.
export async function streamTextFromPrompt(prompt, maxTokens, timeoutMs, endpoint, onChunk) {
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
        messages: [{ role: "user", content: prompt }],
        endpoint,
        sessionId: getSessionId(),
      }),
      signal: controller.signal,
    });
  } catch (networkErr) {
    clearTimeout(timeoutId);
    if (networkErr.name === "AbortError") {
      throw new Error("Request timed out — no response from the API.");
    }
    console.error("Rabbit Hole: network error streaming text", networkErr);
    throw new Error(`Network error: ${networkErr.message || "fetch failed"}`);
  }

  if (!res.ok) {
    clearTimeout(timeoutId);
    let bodySnippet = "";
    try {
      bodySnippet = (await res.text()).slice(0, 200);
    } catch (_) {}
    console.error("Rabbit Hole: stream returned non-OK status", res.status, bodySnippet);
    throw new Error(`API returned ${res.status}${bodySnippet ? `: ${bodySnippet}` : ""}`);
  }

  if (!res.body || !res.body.getReader) {
    // environment doesn't support streaming bodies — fall back to a plain read
    clearTimeout(timeoutId);
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    onChunk(text);
    return text.replace(/```/g, "").trim();
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
    console.error("Rabbit Hole: text stream failed", streamErr);
    if (!gotAnyData) throw streamErr;
    // if we already streamed in some real text before failing, keep it rather
    // than throwing the whole thing away — partial content is still useful
  } finally {
    clearTimeout(timeoutId);
  }

  return fullText.replace(/```/g, "").trim();
}
