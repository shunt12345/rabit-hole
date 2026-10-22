// Supabase Edge Function: generate-hyfax-chains
//
// Writes the day's pool of Hyfax chains (migration 0065): four topics on one
// thread, each an indirect leap from the one before ("Stale Bread to Samurai
// Sword"). The homepage's Spin a thread puts a chain's title in the search
// box, and Dig in opens it (src/ChainView.jsx). Written ahead, in a batch,
// so a spin is instant and free, and by Sonnet with a second checking pass,
// since every leap has to be real for a chain to work.
//
// Runs once a day from pg_cron (migration 0065), protected by the same
// CRON_SECRET as generate-trending-topics. Body (optional): {"count": n}.
//
// Self-contained like every other function here (no shared imports).
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MODEL = Deno.env.get("CHAIN_MODEL") ?? "claude-sonnet-5";
const INPUT_PRICE_PER_M = 2.0;
const OUTPUT_PRICE_PER_M = 10.0;
// Small batches written side by side, each checked as soon as it's done,
// so the whole run fits well inside the function's time limit (two batches
// of 12, checked together at the end, ran past it).
const BATCH_SIZE = 6;
const BATCHES = 4;
// Batches run side by side without seeing each other, so each starts its
// chains in its own subjects (the leaps can still go anywhere).
const BATCH_FOCUS = [
  "food, cooking, plants and animals",
  "the human body, medicine, space and physics",
  "history, art, music and language",
  "sport, money, technology and everyday objects",
];
const RECENT_TITLE_DAYS = 120;
const CALL_TIMEOUT_MS = 90_000;

type Step = { title: string; link: string; why: string; deep: string };
type Chain = { title: string; steps: Step[] };

const RULES = `A Hyfax chain is four topics on one thread. Each step is an INDIRECT leap from the step just before it (not from the first): the two share one real idea, such as the same mechanism, the same principle, the same word with a genuinely shared meaning, the same material, the same person or the same historical moment, while being different subjects. Step 1 is an everyday-curious starting topic. By step 4 the reader should be somewhere surprising and far from where they started, and the title promises that journey.

Example (for the shape only; don't reuse it):
1. Why Bread Goes Stale: starch re-forms tight crystals as the loaf cools.
2. Chocolate Bloom (link: "Same idea, new food"): the same crystal comeback, in cocoa butter instead of starch.
3. Tempering Steel (link: "Same word, new material"): chocolatiers and blacksmiths both temper, heating and cooling on purpose to choose which crystals form.
4. The Katana's Wavy Line (link: "Same trick, one blade"): a clay-coated spine cools slowly while the edge cools fast, two crystal structures in one blade.
Title: "Stale Bread to Samurai Sword"

For each chain:
- "title": "<start> to <end>", 3 to 7 words, title case, the two ends in everyday words (e.g. "Stale Bread to Samurai Sword", not the technical step names).
- "steps": exactly 4, each with:
  - "title": 2 to 5 words, title case, specific.
  - "link": for steps 2 to 4, a 3 to 5 word label naming the kind of leap from the step before ("Same idea, new food"); "" for step 1.
  - "why": one sentence, at most 28 words. For step 1, what it is; for steps 2 to 4, exactly what it shares with the step before, in a warm, curious voice.
  - "deep": 60 to 95 words that go deeper on this step: the real mechanism, numbers or history, plain and specific.
- Every fact must be well established. If you aren't sure a detail is true, leave it out. No puns standing in for a real connection, no myths stated as fact.
- Range widely across subjects: food, nature, the body, space, history, art, music, sport, language, technology, money, everyday objects. No two chains in a batch share a starting subject.
- Plain text only, no markdown.`;

function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

async function callClaude(apiKey: string, prompt: string, maxTokens: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const json = firstJsonObject(text.replace(/```json|```/g, ""));
    if (!json) throw new Error(`No JSON in response: ${text.slice(0, 300)}`);
    const usage = data.usage || {};
    const cost = ((usage.input_tokens || 0) / 1e6) * INPUT_PRICE_PER_M + ((usage.output_tokens || 0) / 1e6) * OUTPUT_PRICE_PER_M;
    return { parsed: JSON.parse(json), cost };
  } finally {
    clearTimeout(timer);
  }
}

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function validChain(raw: any): Chain | null {
  const title = clean(raw?.title, 80);
  const steps = Array.isArray(raw?.steps) ? raw.steps : [];
  if (!/\bto\b/i.test(title) || steps.length !== 4) return null;
  const out = steps.map((s: any, i: number) => ({
    title: clean(s?.title, 60),
    link: i === 0 ? "" : clean(s?.link, 40),
    why: clean(s?.why, 260),
    deep: clean(s?.deep, 900),
  }));
  if (out.some((s: Step, i: number) => !s.title || !s.why || !s.deep || (i > 0 && !s.link))) return null;
  return { title, steps: out };
}

async function writeBatch(apiKey: string, count: number, avoid: string[], focus: string) {
  const avoidBlock = avoid.length ? `\n\nAlready used recently; don't repeat these titles or their starting topics: ${avoid.join("; ")}.` : "";
  const prompt = `Write ${count} Hyfax chains. Start every chain in this batch (step 1) somewhere in: ${focus}.\n\n${RULES}${avoidBlock}\n\nRespond with ONLY valid JSON: {"chains": [{"title": "...", "steps": [{"title": "...", "link": "", "why": "...", "deep": "..."}, ...]}]}`;
  const { parsed, cost } = await callClaude(apiKey, prompt, 5000);
  const chains = (Array.isArray(parsed?.chains) ? parsed.chains : []).map(validChain).filter(Boolean) as Chain[];
  return { chains, cost };
}

// The checking pass: every leap must share a real idea with the step before,
// and every stated fact must hold up. A chain with any doubt is dropped.
async function checkChains(apiKey: string, chains: Chain[]) {
  const listing = chains
    .map((c, i) => `#${i} ${c.title}\n` + c.steps.map((s, j) => `  ${j + 1}. ${s.title}${s.link ? ` (${s.link})` : ""}: ${s.why} ${s.deep}`).join("\n"))
    .join("\n\n");
  const prompt = `You're fact-checking Hyfax chains before readers see them. Each is four steps; each step must share one real idea with the step just before it, and every fact must be well established.

Drop a chain if ANY of these is true: a leap is a pun or a stretch rather than a real shared idea; any stated fact is wrong, disputed, a popular myth, or a number you can't vouch for; a step repeats the one before it.

${listing}

Respond with ONLY valid JSON: {"keep": [indexes of chains that pass], "dropped": [{"index": n, "reason": "..."}]}`;
  const { parsed, cost } = await callClaude(apiKey, prompt, 2000);
  const keep = new Set((Array.isArray(parsed?.keep) ? parsed.keep : []).map(Number));
  return { kept: chains.filter((_, i) => keep.has(i)), dropped: parsed?.dropped || [], cost };
}

serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY secret is not set" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  const body = await req.json().catch(() => ({}));
  const perBatch = Math.max(1, Math.min(BATCH_SIZE, Number(body?.count) || BATCH_SIZE));

  const since = new Date(Date.now() - RECENT_TITLE_DAYS * 86_400_000).toISOString();
  const { data: recent } = await supabase.from("hyfax_chains").select("title").gte("created_at", since).limit(400);
  const avoid = (recent || []).map((r: { title: string }) => r.title);

  // Each batch is written, then checked, on its own; a batch that fails
  // either step is just left out of today's pool.
  const results = await Promise.allSettled(
    Array.from({ length: BATCHES }, async (_, i) => {
      const batch = await writeBatch(apiKey, perBatch, avoid, BATCH_FOCUS[i % BATCH_FOCUS.length]);
      if (!batch.chains.length) return { written: 0, kept: [] as Chain[], dropped: [], cost: batch.cost };
      // Without the check, nothing from this batch goes out: a wrong chain
      // is worse than fewer new ones (yesterday's pool keeps spinning).
      const check = await checkChains(apiKey, batch.chains);
      return { written: batch.chains.length, kept: check.kept, dropped: check.dropped, cost: batch.cost + check.cost };
    })
  );
  let cost = 0;
  let written = 0;
  const errors: string[] = [];
  const dropped: unknown[] = [];
  const seen = new Set(avoid.map((t) => t.toLowerCase()));
  const kept: Chain[] = [];
  for (const r of results) {
    if (r.status === "rejected") {
      errors.push(String(r.reason));
      continue;
    }
    cost += r.value.cost;
    written += r.value.written;
    dropped.push(...r.value.dropped);
    for (const c of r.value.kept) {
      if (seen.has(c.title.toLowerCase())) continue;
      seen.add(c.title.toLowerCase());
      kept.push(c);
    }
  }
  if (!kept.length) {
    return new Response(JSON.stringify({ error: "No chains kept", written, dropped, errors }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  const perChain = kept.length ? cost / kept.length : 0;
  if (kept.length) {
    const { error } = await supabase
      .from("hyfax_chains")
      .insert(kept.map((c) => ({ title: c.title, steps: c.steps, model: MODEL, cost_usd: perChain })));
    if (error) return new Response(JSON.stringify({ error: `Insert failed: ${error.message}` }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  return new Response(
    JSON.stringify({ written, kept: kept.length, dropped, errors, cost_usd: Number(cost.toFixed(4)), titles: kept.map((c) => c.title) }),
    { headers: { "Content-Type": "application/json" } }
  );
});
