// Hyfax chains (migration 0065): four topics on one thread, written ahead in
// a daily batch. Spin a thread puts a chain's title in the homepage search
// box; Dig in opens the chain (ChainView.jsx). Reading the pool is a plain
// anon read, so a spin is instant and free; opening a chain counts as a page.

const POOL_URL = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/hyfax_chains?select=id,title,steps&status=eq.approved&order=created_at.desc&limit=150`;
const SEEN_KEY = "hyfax-chains-seen";
const SEEN_MAX = 300;

export async function fetchChainPool() {
  const res = await fetch(POOL_URL, {
    headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`hyfax_chains ${res.status}`);
  const rows = await res.json();
  return rows.filter((r) => Array.isArray(r.steps) && r.steps.length === 4);
}

// One thread by id, for a link to a thread outside the pool: the TikTok
// ad's own thread (status 'campaign', migration 0067) is readable but never
// in Spin a thread or the Hyfax of the Day rotation.
export async function fetchChain(id) {
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/hyfax_chains?select=id,title,steps&id=eq.${Number(id)}`, {
    headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`hyfax_chains ${res.status}`);
  const [row] = await res.json();
  return row && Array.isArray(row.steps) && row.steps.length === 4 ? row : null;
}

function loadSeen() {
  try {
    const ids = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

// The next chain this browser hasn't been offered yet, newest first; once
// every chain has been offered, round again from the newest.
export function nextChain(pool, currentId = null) {
  if (!pool.length) return null;
  const seen = loadSeen();
  const fresh = pool.filter((c) => !seen.includes(c.id) && c.id !== currentId);
  const pick = fresh[0] || pool.find((c) => c.id !== currentId) || pool[0];
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([pick.id, ...seen.filter((id) => id !== pick.id)].slice(0, SEEN_MAX)));
  } catch {
    // no storage: spins may repeat sooner
  }
  return pick;
}

// The Hyfax of the Day: the approved threads in a fixed order, one per US
// Eastern calendar day in rotation. send-daily-digest picks the same way
// (threadOfTheDay there), so the homepage and the email always agree.
export function nyDayNumber(date = new Date()) {
  const [y, m, d] = date.toLocaleDateString("en-CA", { timeZone: "America/New_York" }).split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}
export function threadOfTheDay(pool, date = new Date()) {
  if (!pool.length) return null;
  const ordered = [...pool].sort((a, b) => a.id - b.id);
  return ordered[nyDayNumber(date) % ordered.length];
}

// "Coin Flips to Encrypted Bank Transfers" as its two ends, for the
// From / to layout. A title without " to " keeps it all as the start.
export function splitThreadTitle(title) {
  const m = String(title || "").match(/^(.+?)\s+to\s+(.+)$/i);
  return m ? { from: m[1].trim(), to: m[2].trim() } : { from: String(title || ""), to: "" };
}

export function isChainTitle(text, chain) {
  return !!chain && text.trim().toLowerCase() === chain.title.trim().toLowerCase();
}
