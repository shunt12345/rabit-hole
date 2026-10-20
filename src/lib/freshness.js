// After a deploy, a tab (or home-screen app) opened earlier keeps running
// the old code against new data, which can show a page half-updated (new
// page text in the old layout). This notices a newer build is live by
// comparing the bundle the page is running with the one index.html now
// points at, and reloads at a moment that won't yank anyone off a page:
// when they tap Home, or come back to the tab while on the home screen.

const CHECK_EVERY_MS = 5 * 60 * 1000;
let stale = false;

// The built bundle this page loaded ("/assets/index-<hash>.js"); none in
// dev, where nothing here runs.
const runningBundle = () => document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute("src") || null;

async function checkForNewBuild() {
  const mine = runningBundle();
  if (!mine || stale) return stale;
  try {
    const html = await (await fetch("/", { cache: "no-store" })).text();
    const live = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
    stale = !!live && live !== mine;
  } catch {
    // Offline or a blip: try again next time.
  }
  return stale;
}

const reloadHome = () => window.location.assign(window.location.pathname);

// isOnHome: whether the reader is on the home screen right now.
export function watchForNewBuild(isOnHome) {
  if (!runningBundle()) return () => {};
  const timer = setInterval(checkForNewBuild, CHECK_EVERY_MS);
  const onVisible = async () => {
    if (document.visibilityState === "visible" && (await checkForNewBuild()) && isOnHome()) reloadHome();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

// Called on the way home: true when it's reloading onto the new build
// instead.
export function reloadIfNewBuild() {
  if (!stale) return false;
  reloadHome();
  return true;
}
