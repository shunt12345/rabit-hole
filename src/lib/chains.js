// Hyfax chains (migration 0065): four topics on one thread, written ahead in
// a daily batch. Spin a thread puts a chain's title in the homepage search
// box; Dig in opens the chain (ChainView.jsx). Reading the pool is a plain
// anon read, so a spin is instant and never costs a search.

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

export function isChainTitle(text, chain) {
  return !!chain && text.trim().toLowerCase() === chain.title.trim().toLowerCase();
}
