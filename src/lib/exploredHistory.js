// "Continue exploring" history — two tiers, same shape and same 8-entry
// cap either way:
//   - Local (anonymous): localStorage, scoped to one browser. Works with
//     no account at all, but doesn't follow you anywhere.
//   - Account (signed in): the explored_topics table (see migration
//     0019), scoped to the user via RLS. Follows a signed-in identity
//     across devices/browsers instead of being stuck on whichever one
//     they were on when they dug in.
//
// App.jsx picks which tier to read/write based on whether someone's
// signed in — see recordExploredRoot/loadExploredHistory there. On
// first sign-in, migrateLocalHistoryToAccount below carries over
// whatever local history already existed so it isn't just lost.
//
// Every entry stores a full root snapshot (overview + children), not
// just the topic label, so resuming is instant — no regeneration, no
// extra Claude call, nothing counted against the free-search limit.
import { supabase } from "./supabaseClient.js";

const KEY = "hyfax-explored-topics";
const MAX_ENTRIES = 8;

function normalizeChildren(children) {
  return (children || []).map((c) => ({ label: c.label, teaser: c.teaser, type: c.type }));
}

// ---- Local tier (localStorage) ----

function readLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocal(entries) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Storage full, disabled, or unavailable (private browsing) — losing
    // history silently is fine, this is a nice-to-have, not core function.
  }
}

export function getLocalHistory() {
  return readLocal();
}

// Deduped by label — re-digging the same topic refreshes and re-fronts
// its entry instead of creating a second one. Most-recent-first, capped
// at MAX_ENTRIES so this can't grow without bound.
export function saveLocalRoot({ label, fullTopic, overview, children }) {
  if (!label) return;
  const entries = readLocal().filter((e) => e.label !== label);
  entries.unshift({
    label,
    fullTopic: fullTopic || label,
    overview: overview || "",
    children: normalizeChildren(children),
    savedAt: Date.now(),
  });
  writeLocal(entries.slice(0, MAX_ENTRIES));
}

// ---- Account tier (Supabase, signed-in users only) ----

export async function getAccountHistory(userId) {
  const { data, error } = await supabase
    .from("explored_topics")
    .select("label, full_topic, overview, children, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(MAX_ENTRIES);
  if (error) {
    console.error("Hyfax: failed to read account explored history", error);
    return [];
  }
  return (data || []).map((row) => ({
    label: row.label,
    fullTopic: row.full_topic || row.label,
    overview: row.overview || "",
    children: row.children || [],
    savedAt: new Date(row.updated_at).getTime(),
  }));
}

// Deletes anything past the MAX_ENTRIES most-recently-touched rows for
// this user — the account-tier equivalent of the local tier's
// `.slice(0, MAX_ENTRIES)`. A small, low-traffic table (one row per
// distinct topic ever dug into while signed in), so fetching every id
// first is simpler than a SQL-side trigger and plenty fast enough.
async function pruneAccountHistory(userId) {
  const { data, error } = await supabase
    .from("explored_topics")
    .select("id")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error || !data) return;
  const staleIds = data.slice(MAX_ENTRIES).map((row) => row.id);
  if (staleIds.length) {
    await supabase.from("explored_topics").delete().in("id", staleIds);
  }
}

// Never throws — a failed save here should never interrupt someone
// reading their article, so every failure is swallowed after logging,
// same posture as the local tier's try/catch around localStorage.
//
// `savedAt` is optional and only meant for migrateLocalHistoryToAccount
// below — it lets a migrated row keep its ORIGINAL local save time as
// `updated_at` instead of the moment it happened to get copied over.
// Without this, migrating a list of local entries (already
// most-recent-first) in a loop would stamp whichever one is migrated
// LAST with the newest `updated_at`, silently reversing the order. A
// normal fresh save (from startTopic/resumeExploredRoot) never passes
// this, so it correctly defaults to right now.
export async function saveAccountRoot(userId, { label, fullTopic, overview, children, savedAt }) {
  if (!label) return;
  try {
    const { error } = await supabase.from("explored_topics").upsert(
      {
        user_id: userId,
        label,
        full_topic: fullTopic || label,
        overview: overview || "",
        children: normalizeChildren(children),
        updated_at: new Date(savedAt || Date.now()).toISOString(),
      },
      { onConflict: "user_id,label" }
    );
    if (error) throw error;
    await pruneAccountHistory(userId);
  } catch (e) {
    console.error("Hyfax: failed to save account explored topic", e);
  }
}

// Runs once right after someone signs in — carries over whatever local
// (browser-only) history already exists into their account so it isn't
// just abandoned the moment they get an account-level history instead.
// Doesn't clear local storage afterward: leaving it behind is harmless,
// and it stays as a fallback if the account write ever fails.
export async function migrateLocalHistoryToAccount(userId) {
  const local = readLocal();
  if (!local.length) return;
  for (const entry of local) {
    await saveAccountRoot(userId, entry);
  }
}
