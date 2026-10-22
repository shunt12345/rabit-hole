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
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
};
const INPUT_PRICE_PER_M = (PRICES[MODEL] ?? PRICES["claude-sonnet-5"]).input;
const OUTPUT_PRICE_PER_M = (PRICES[MODEL] ?? PRICES["claude-sonnet-5"]).output;
// Small batches written side by side, each checked as soon as it's done,
// so the whole run fits well inside the function's time limit (two batches
// of 12, checked together at the end, ran past it).
// Three chains per reply: six ran past the reply's length limit and came
// back cut off mid-JSON, and the check now thinks before answering, so
// each batch has to stay small to fit the function's time limit.
const BATCH_SIZE = 3;
const BATCHES = 6;
// Batches run side by side without seeing each other, so each starts its
// chains in its own subjects (the leaps can still go anywhere).
const BATCH_FOCUS = [
  "food, cooking and drink",
  "plants, animals and the natural world",
  "the human body, medicine and the mind",
  "space, physics, chemistry and engineering",
  "history, art, music and language",
  "sport, money, technology and everyday objects",
];
const RECENT_TITLE_DAYS = 120;
const CALL_TIMEOUT_MS = 90_000;

// kind: the kind of leap from the step before ("" for step 1). An indirect
// leap shares a mechanism or principle; a tangent side-steps through a
// looser but real link (the same word, person, place, era or material).
type Step = { title: string; kind: string; link: string; why: string; deep: string };
type Chain = { title: string; steps: Step[] };

const RULES = `A Hyfax chain is four topics on one thread. Each step leaps from the step just before it (not from the first), to a different subject that shares one real thing with it. There are two kinds of leap, and every chain uses both (at least one of each):
- "indirect": the two share the same mechanism, law or principle (the same crystal comeback in starch and in cocoa butter).
- "tangent": a looser side-step through something real they have in common: the same word, the same person, the same place, the same era or the same material (chocolatiers and blacksmiths both "temper"). Step 1 is an everyday-curious starting topic. By step 4 the reader should be somewhere surprising and far from where they started, and the title promises that journey.

The two ends must NOT connect directly. Pick step 1 and step 4 first: they must be in different fields, and nobody should be able to explain step 4 from step 1 in a single sentence (both fermentation, both the same frequency, one copied from the other, one famously found in the other: all too direct). Only the middle steps make the journey possible, so the title sounds impossible until you read the chain.

Example (for the shape only; don't reuse it):
1. Why Bread Goes Stale: starch re-forms tight crystals as the loaf cools.
2. Chocolate Bloom (indirect, link: "Same idea, new food"): the same crystal comeback, in cocoa butter instead of starch.
3. Tempering Steel (tangent, link: "Same word, new material"): chocolatiers and blacksmiths both temper, heating and cooling on purpose to choose which crystals form.
4. The Katana's Wavy Line (indirect, link: "Same trick, one blade"): a clay-coated spine cools slowly while the edge cools fast, two crystal structures in one blade.
Title: "Stale Bread to Samurai Sword"

For each chain:
- "title": "<start> to <end>", 3 to 7 words, title case, the two ends in everyday words (e.g. "Stale Bread to Samurai Sword", not the technical step names).
- "steps": exactly 4, each with:
  - "title": 2 to 5 words, title case, specific.
  - "kind": for steps 2 to 4, "indirect" or "tangent" (see above); "" for step 1.
  - "link": for steps 2 to 4, a 3 to 5 word label naming the leap from the step before ("Same idea, new food"); "" for step 1.
  - "why": one sentence, at most 28 words. For step 1, what it is; for steps 2 to 4, exactly what it shares with the step before, in a warm, curious voice.
  - "deep": 60 to 95 words that go deeper on this step: the real mechanism, numbers or history, plain and specific.
- Every fact must be well established. If you aren't sure a detail is true, leave it out. No puns standing in for a real connection, no myths stated as fact.
- Each leap must name a shared idea a specialist would agree with: the same physical law, the same nerve, the same material, the same invention. "Both involve X" in a loose sense isn't a leap.
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

// think: let the model reason before answering (the checking pass); the
// writing pass answers straight away.
async function callClaude(apiKey: string, prompt: string, maxTokens: number, think = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, thinking: { type: think ? "adaptive" : "disabled" }, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    if (data.stop_reason === "max_tokens") throw new Error(`Reply cut off at ${maxTokens} tokens (${text.length} chars)`);
    const json = firstJsonObject(text.replace(/```json|```/g, ""));
    if (!json) throw new Error(`No JSON in response (stop: ${data.stop_reason}): ${text.slice(0, 300)}`);
    const usage = data.usage || {};
    const cost = ((usage.input_tokens || 0) / 1e6) * INPUT_PRICE_PER_M + ((usage.output_tokens || 0) / 1e6) * OUTPUT_PRICE_PER_M;
    return { parsed: JSON.parse(json), cost };
  } finally {
    clearTimeout(timer);
  }
}

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function validChain(raw: any): Chain | null {
  // "Wifi Signal To Microwave Popcorn" came back now and then; the joining
  // word is always a small "to".
  const title = clean(raw?.title, 80).replace(/\s+to\s+/i, " to ");
  const steps = Array.isArray(raw?.steps) ? raw.steps : [];
  if (!/\bto\b/i.test(title) || steps.length !== 4) return null;
  const out = steps.map((s: any, i: number) => ({
    title: clean(s?.title, 60),
    kind: i === 0 ? "" : String(s?.kind || "").trim().toLowerCase() === "tangent" ? "tangent" : "indirect",
    link: i === 0 ? "" : clean(s?.link, 60),
    why: clean(s?.why, 260),
    deep: clean(s?.deep, 900),
  }));
  if (out.some((s: Step, i: number) => !s.title || !s.why || !s.deep || (i > 0 && !s.link))) return null;
  // Every chain mixes both kinds of leap.
  const kinds = out.slice(1).map((s: Step) => s.kind);
  if (!kinds.includes("tangent") || !kinds.includes("indirect")) return null;
  return { title, steps: out };
}

async function writeBatch(apiKey: string, count: number, avoid: string[], focus: string) {
  const avoidBlock = avoid.length ? `\n\nAlready used recently; don't repeat these titles or their starting topics: ${avoid.join("; ")}.` : "";
  const prompt = `Write ${count} Hyfax chains. Start every chain in this batch (step 1) somewhere in: ${focus}.\n\n${RULES}${avoidBlock}\n\nRespond with ONLY valid JSON: {"chains": [{"title": "...", "steps": [{"title": "...", "kind": "", "link": "", "why": "...", "deep": "..."}, ...]}]}`;
  const { parsed, cost } = await callClaude(apiKey, prompt, 7000);
  const chains = (Array.isArray(parsed?.chains) ? parsed.chains : []).map(validChain).filter(Boolean) as Chain[];
  return { chains, cost };
}

// The checking pass: every leap must share a real idea with the step before,
// and every stated fact must hold up. A chain with any doubt is dropped.
async function checkChains(apiKey: string, chains: Chain[]) {
  const listing = chains
    .map((c, i) => `#${i} ${c.title}\n` + c.steps.map((s, j) => `  ${j + 1}. ${s.title}${s.kind ? ` [${s.kind}: ${s.link}]` : ""}: ${s.why} ${s.deep}`).join("\n"))
    .join("\n\n");
  const prompt = `You're the strict fact-checker for Hyfax chains, and readers trust every word. Each chain is four steps; each step must share ONE real, specific idea with the step just before it.

For every chain, go leap by leap (1 to 2, 2 to 3, 3 to 4): name the single idea the two steps genuinely share, then judge whether that connection is real science, history or language, or only sounds plausible. Then check every factual claim in every step.

Drop the chain if ANY of these is true:
- the two ends connect directly: someone could explain step 4 from step 1 in one sentence without the middle steps, or steps 1 and 4 are in the same field (e.g. sourdough and Roman wine are both yeast fermentation; shark skin and swimsuits are copied one from the other; wifi and microwave ovens share a frequency);
- a leap is a pun, a loose analogy, a "both are about X" stretch, or names a shared idea that isn't actually true (e.g. "same electron behavior" for unrelated colors);
- any claim is wrong, disputed or a popular myth (e.g. that Grace Hopper's moth gave us the word "bug"; that a word has a folk etymology stated as fact);
- a number or mechanism is something you can't vouch for;
- a step refers to something the chain never introduced;
- a step's own explanation contradicts its connecting line (e.g. calling a collapse resonance, then explaining it wasn't);
- the title misdescribes the chain's ends (e.g. calling mutineers "shipwrecked").
Be hard to please: a real chain should survive a specialist's red pen. Expect to drop a lot of them; dropping a good chain costs little, keeping a wrong one costs readers' trust.

${listing}

Respond with ONLY valid JSON: {"keep": [indexes of chains that pass], "dropped": [{"index": n, "reason": "..."}]}`;
  const { parsed, cost } = await callClaude(apiKey, prompt, 12000, true);
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
      // Pending until approved in /queue (migration 0066).
      .insert(kept.map((c) => ({ title: c.title, steps: c.steps, model: MODEL, cost_usd: perChain, status: "pending" })));
    if (error) return new Response(JSON.stringify({ error: `Insert failed: ${error.message}` }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  return new Response(
    JSON.stringify({ written, kept: kept.length, dropped, errors, cost_usd: Number(cost.toFixed(4)), titles: kept.map((c) => c.title) }),
    { headers: { "Content-Type": "application/json" } }
  );
});
