// Daily hero precompute: opens every hero topic on the live site, then
// every first-level thread under it (its thread cards and inline links),
// so each page is generated once and cached before visitors arrive. A
// thread tap opens its preview (which loads and caches the thread's page);
// Explore then opens it, which caches its own threads too. Run by
// .github/workflows/precompute-hero.yml shortly after the 07:00 UTC hero
// switch, or by hand.
//
// It drives the real site in a headless browser rather than calling the
// proxy directly, so pages are cached exactly the way a visitor's click
// would cache them (same prompts, same cache keys, same article format).
// It browses in ?hyfax_test=1 mode (kept out of /admin numbers and the
// Reddit pixel) and adds PRECOMPUTE_SECRET to each proxy request, which
// rabbit-hole-proxy-v2 accepts in place of the free-page limit.
//
// Env: PRECOMPUTE_SECRET (required), APP_URL (default https://www.hyfax.app),
// MAX_TOPICS / MAX_THREADS (caps for a test run, default all), CHROMIUM_PATH / CHROMIUM_ARGS for
// running somewhere other than a stock runner.
import { chromium } from "playwright";

const APP_URL = (process.env.APP_URL || "https://www.hyfax.app").replace(/\/$/, "");
const SECRET = (process.env.PRECOMPUTE_SECRET || "").trim();
const MAX_TOPICS = Number(process.env.MAX_TOPICS || Infinity);
const MAX_THREADS = Number(process.env.MAX_THREADS || Infinity);
const PAGE_TIMEOUT_MS = 120_000;

if (!SECRET) {
  console.error("PRECOMPUTE_SECRET is not set.");
  process.exit(1);
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: (process.env.CHROMIUM_ARGS || "").split(" ").filter(Boolean),
});
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

// The secret rides along in each proxy request's JSON body.
await page.route("**/functions/v1/rabbit-hole-proxy-v2", async (route) => {
  const req = route.request();
  if (req.method() !== "POST") return route.continue();
  try {
    const body = JSON.parse(req.postData() || "{}");
    return route.continue({ postData: JSON.stringify({ ...body, precomputeSecret: SECRET }) });
  } catch {
    return route.continue();
  }
});

// Proxy requests still in flight, and the riddle rows the hero page loads
// (so the riddle game can be marked solved, which shows its
// "Read about it" button).
let inflight = 0;
const riddleIds = new Set();
// Whether the proxy accepted the secret: it then reports the browser as
// funded (X-Trial-Funded: 1), so the site doesn't hide threads at the free
// limit. Without that, every topic after the first few shows no threads.
let secretAccepted = null;
// The proxy's own verdict on the secret (X-Precompute), if it sends one.
let proxyVerdict = null;
page.on("request", (r) => r.url().includes("rabbit-hole-proxy-v2") && inflight++);
const settle = (r) => r.url().includes("rabbit-hole-proxy-v2") && inflight--;
page.on("requestfinished", settle);
page.on("requestfailed", settle);
page.on("response", async (res) => {
  if (res.url().includes("rabbit-hole-proxy-v2") && res.request().method() === "POST") {
    const funded = res.headers()["x-trial-funded"];
    proxyVerdict = proxyVerdict || res.headers()["x-precompute"] || null;
    if (funded !== undefined) secretAccepted = secretAccepted || funded === "1";
  }
  if (!res.url().includes("/rest/v1/trending_topics_cache")) return;
  try {
    for (const row of await res.json()) if (row.field === "Riddle" && row.id) riddleIds.add(row.id);
  } catch {
    // Not JSON (an error) — nothing to collect.
  }
});

// A page is done once nothing is loading or typing and no proxy request
// has been in flight for a few seconds (the cache write follows the text).
async function waitUntilDone() {
  const start = Date.now();
  let quietSince = null;
  while (Date.now() - start < PAGE_TIMEOUT_MS) {
    const busy = inflight > 0 || (await page.locator(".rh-cursor-blink, .animate-spin").count()) > 0;
    if (busy) quietSince = null;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince > 3000) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function openHome() {
  await page.goto(`${APP_URL}/?hyfax_test=1`);
  await page.locator('[data-precompute="hero"]').first().waitFor({ timeout: 30_000 });
  await waitUntilDone();
}

async function openHero(i) {
  await openHome();
  await page.locator('[data-precompute="hero"]').nth(i).click();
  return waitUntilDone();
}

async function threadLabels() {
  // One entry per thread element, in page order (so an index here is its
  // locator's nth).
  return (await page.locator('[data-precompute="thread"]').allInnerTexts()).map((t) => t.split("\n")[0].trim());
}

// Mark every riddle solved for this browser so the game card offers
// "Read about it" (which opens the answer with its clue threads).
await openHome();
await page.evaluate((ids) => {
  for (const id of ids) {
    localStorage.setItem(`hyfax-riddle-${id}`, JSON.stringify({ hints: 0, wrong: [], outcome: "solved", guesses: 1, pending: null }));
  }
}, [...riddleIds]);

await openHome();
const heroCount = Math.min(MAX_TOPICS, await page.locator('[data-precompute="hero"]').count());
console.log(`${heroCount} hero topics`);

// GitHub Actions annotations (readable from the run's check-run API, not
// just the log), so the outcome shows up without opening the log.
function annotate(level, message) {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level}::${message}`);
}

let pages = 0;
let failures = 0;
let threadsFound = 0;
const retries = [];

// Opens hero i, then its thread `label` (and the thread's own Explore page).
// "ok", "missing" (not on the page any more) or "retry" (timed out/errored).
async function openThread(i, label) {
  const t = Date.now();
  try {
    await openHero(i);
    // Matched on the exact label (a card's first line, or a link's text),
    // so "Ice" never clicks "Glacier Ice".
    const index = (await threadLabels()).indexOf(label);
    if (index === -1) {
      console.log(`   - ${label}: not found on reopen, skipped`);
      return "missing";
    }
    await page.locator('[data-precompute="thread"]').nth(index).click();
    let done = await waitUntilDone();
    const explore = page.locator('[data-precompute="explore"]').first();
    if (await explore.count()) {
      await explore.click();
      done = (await waitUntilDone()) && done;
    }
    pages++;
    console.log(`   - ${label}: ${done ? "ok" : "timed out"} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    return done ? "ok" : "retry";
  } catch (e) {
    // One thread failing shouldn't end the run for every hero after it.
    console.log(`   - ${label}: failed (${e.message.split("\n")[0]})`);
    return "retry";
  }
}
for (let i = 0; i < heroCount; i++) {
  const t = Date.now();
  const ok = await openHero(i);
  const topic = (await page.locator("h2").first().textContent())?.trim();
  pages++;
  if (!ok) failures++;
  const labels = [...new Set((await threadLabels()).filter(Boolean))].slice(0, MAX_THREADS);
  threadsFound += labels.length;
  if (secretAccepted === false) {
    const why = {
      unset: "rabbit-hole-proxy-v2 has no PRECOMPUTE_SECRET of 16+ characters — set it in Supabase function secrets.",
      mismatch: `the GitHub secret (${SECRET.length} characters) doesn't match the Supabase one — re-paste the same value in both, watching for spaces.`,
    }[proxyVerdict] || "the proxy didn't report on the secret, so the deployed rabbit-hole-proxy-v2 is an older version — redeploy it.";
    annotate("error", `The proxy did not accept PRECOMPUTE_SECRET: ${why}`);
    console.error("PRECOMPUTE_SECRET was not accepted by the proxy — stopping.");
    await browser.close();
    process.exit(1);
  }
  console.log(`\n[${i + 1}/${heroCount}] ${topic} — ${ok ? "ok" : "timed out"} (${((Date.now() - t) / 1000).toFixed(1)}s), ${labels.length} threads`);

  for (const label of labels) {
    const result = await openThread(i, label);
    if (result === "retry") retries.push({ i, label });
    else if (result !== "ok") failures++;
  }
}

// A page that timed out or errored gets one more try at the end (a slow
// generation usually finishes on the second pass); only a second miss
// counts as a failure.
if (retries.length) console.log(`\nRetrying ${retries.length} page(s)`);
for (const { i, label } of retries) {
  if ((await openThread(i, label)) !== "ok") failures++;
}

const summary = `${heroCount} topics, ${threadsFound} threads, ${pages} pages opened, ${failures} timed out`;
console.log(`\nDone: ${summary}.`);
annotate(failures || !threadsFound ? "error" : "notice", `Precompute: ${summary}.`);
await browser.close();
process.exit(failures > 0 || threadsFound === 0 ? 1 : 0);
