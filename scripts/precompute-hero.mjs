// Daily hero precompute: opens every hero topic on the live site, then
// every first-level thread under it (its thread cards and inline links),
// so each page is generated once and cached before visitors arrive. Run by
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
const SECRET = process.env.PRECOMPUTE_SECRET;
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
page.on("request", (r) => r.url().includes("rabbit-hole-proxy-v2") && inflight++);
const settle = (r) => r.url().includes("rabbit-hole-proxy-v2") && inflight--;
page.on("requestfinished", settle);
page.on("requestfailed", settle);
page.on("response", async (res) => {
  if (res.url().includes("rabbit-hole-proxy-v2") && res.request().method() === "POST") {
    const funded = res.headers()["x-trial-funded"];
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
  return (await page.locator('[data-precompute="thread"]').allInnerTexts()).map((t) => t.split("\n")[0].trim()).filter(Boolean);
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
for (let i = 0; i < heroCount; i++) {
  let t = Date.now();
  const ok = await openHero(i);
  const topic = (await page.locator("h2").first().textContent())?.trim();
  pages++;
  if (!ok) failures++;
  const labels = [...new Set(await threadLabels())].slice(0, MAX_THREADS);
  threadsFound += labels.length;
  if (secretAccepted === false) {
    annotate("error", "The proxy did not accept PRECOMPUTE_SECRET (check it matches the rabbit-hole-proxy-v2 secret, 16+ characters, and that the function was redeployed).");
    console.error("PRECOMPUTE_SECRET was not accepted by the proxy — stopping.");
    await browser.close();
    process.exit(1);
  }
  console.log(`\n[${i + 1}/${heroCount}] ${topic} — ${ok ? "ok" : "timed out"} (${((Date.now() - t) / 1000).toFixed(1)}s), ${labels.length} threads`);

  for (const label of labels) {
    t = Date.now();
    await openHero(i);
    const link = page.locator('[data-precompute="thread"]', { hasText: label }).first();
    if (!(await link.count())) {
      console.log(`   - ${label}: not found on reopen, skipped`);
      continue;
    }
    await link.click();
    const done = await waitUntilDone();
    pages++;
    if (!done) failures++;
    console.log(`   - ${label}: ${done ? "ok" : "timed out"} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }
}

const summary = `${heroCount} topics, ${threadsFound} threads, ${pages} pages opened, ${failures} timed out`;
console.log(`\nDone: ${summary}.`);
annotate(failures || !threadsFound ? "error" : "notice", `Precompute: ${summary}.`);
await browser.close();
process.exit(failures > 0 || threadsFound === 0 ? 1 : 0);
