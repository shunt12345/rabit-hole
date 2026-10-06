import { useEffect, useState } from "react";
import { Loader2, AlertCircle, RefreshCw, LogOut, Check, X } from "lucide-react";
import { getCurrentUser, onAuthStateChange, sendMagicLink, signOut, getAccessToken } from "./lib/auth.js";

// Served at /queue (see main.jsx) — split out from AdminDashboard.jsx
// (which stays at /admin for the usage-stats side of things) so the
// actual daily task — reviewing today's picks before they publish — has
// its own focused page instead of living buried under a long analytics
// dashboard. Same auth (magic link) and the same server-side gate as
// /admin: this page enforces nothing itself, it just won't have anything
// to show if the signed-in account isn't on admin-review-queue's
// ADMIN_USER_IDS allowlist.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const COLORS = {
  bg: "#14100C",
  card: "#1F1811",
  border: "#3A2E20",
  text: "#F1E6D3",
  dim: "#A89478",
  accent: "#E3A73C",
  bad: "#D98A6E",
};

// One pending/rejected trending_topics_cache row, with its own
// approve/reject buttons — a plain card rather than a table row, since a
// teaser can run to a full sentence or two and a table cell would
// truncate or wrap awkwardly compared to a card's full width.
function ReviewCard({ row, onDecide, busy }) {
  const isRejected = row.status === "rejected";
  return (
    <div
      className="rounded-2xl border p-4"
      style={{
        backgroundColor: COLORS.card,
        borderColor: isRejected ? COLORS.bad : COLORS.border,
        opacity: isRejected ? 0.7 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="rh-mono rh-text-10 uppercase tracking-wider mb-1 flex items-center gap-2" style={{ color: COLORS.accent }}>
            {row.field}
            {isRejected && <span style={{ color: COLORS.bad }}>· rejected</span>}
            {row.category && <span style={{ color: COLORS.dim }}>· {row.category}</span>}
          </div>
          <div className="text-base font-semibold" style={{ color: COLORS.text }}>
            {row.topic}
          </div>
          <p className="text-sm mt-1" style={{ color: COLORS.dim }}>
            {row.teaser}
          </p>
          {Array.isArray(row.options) && row.options.length > 0 && (
            <p className="text-xs mt-1" style={{ color: COLORS.dim }}>
              Decoys: {row.options.join(", ")}
            </p>
          )}
          <div className="text-xs mt-2" style={{ color: COLORS.dim }}>
            {new Date(row.generated_at).toLocaleString()}
            {row.source_url && (
              <>
                {" · "}
                <a href={row.source_url} target="_blank" rel="noreferrer" style={{ color: COLORS.dim, textDecoration: "underline" }}>
                  source
                </a>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onDecide(row.id, "approve")}
            disabled={busy}
            className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            style={{ backgroundColor: COLORS.accent, color: "#14100C" }}
          >
            <Check size={13} /> Approve
          </button>
          {!isRejected && (
            <button
              onClick={() => onDecide(row.id, "reject")}
              disabled={busy}
              className="flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs disabled:opacity-40"
              style={{ borderColor: COLORS.bad, color: COLORS.bad }}
            >
              <X size={13} /> Reject
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ReviewQueue() {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = signed out
  const [email, setEmail] = useState("");
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [authError, setAuthError] = useState(null);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Which row id (or "all" for the bulk action) currently has an
  // in-flight approve/reject call — disables just that row's buttons
  // rather than freezing the whole queue while one decision is saving.
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    getCurrentUser().then(setUser);
    return onAuthStateChange(setUser);
  }, []);

  const call = async (action, extra) => {
    const token = await getAccessToken();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-review-queue`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, ...extra }),
    });
    if (res.status === 403) throw new Error("__forbidden__");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status}).`);
    }
    return res.json();
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { rows } = await call("list");
      setRows(rows || []);
    } catch (e) {
      setError(e.message === "__forbidden__" ? "This account isn't on the admin allowlist." : e.message || "Failed to load the review queue.");
    } finally {
      setLoading(false);
    }
  };

  const decide = async (id, action) => {
    setBusyId(id);
    try {
      await call(action, { id });
      await load();
    } catch (e) {
      setError(e.message || "That decision didn't save — try again.");
    } finally {
      setBusyId(null);
    }
  };

  const approveAll = async () => {
    setBusyId("all");
    try {
      await call("approveAll");
      await load();
    } catch (e) {
      setError(e.message || "Approve all didn't go through — try again.");
    } finally {
      setBusyId(null);
    }
  };

  useEffect(() => {
    if (user) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (user === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: COLORS.bg, color: COLORS.text }}>
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ backgroundColor: COLORS.bg }}>
        <div className="w-full max-w-sm rounded-2xl border p-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
          <h1 className="rh-display text-xl mb-4" style={{ color: COLORS.text }}>
            Hyfax Review Queue
          </h1>
          {magicLinkSent ? (
            <p className="text-sm" style={{ color: COLORS.dim }}>
              Check your email for a sign-in link.
            </p>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setAuthError(null);
                try {
                  await sendMagicLink(email);
                  setMagicLinkSent(true);
                } catch (err) {
                  setAuthError(err.message || "Couldn't send the link.");
                }
              }}
            >
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none mb-3"
                style={{ backgroundColor: COLORS.bg, borderColor: COLORS.border, color: COLORS.text }}
              />
              <button
                type="submit"
                className="w-full rounded-lg px-3 py-2 text-sm font-medium"
                style={{ backgroundColor: COLORS.accent, color: "#14100C" }}
              >
                Send sign-in link
              </button>
              {authError && (
                <div className="flex items-center gap-1.5 text-xs mt-3" style={{ color: COLORS.bad }}>
                  <AlertCircle size={13} /> {authError}
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    );
  }

  const pendingCount = rows.filter((r) => r.status === "pending").length;

  return (
    <div className="min-h-screen px-5 py-8" style={{ backgroundColor: COLORS.bg }}>
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <h1 className="rh-display text-2xl" style={{ color: COLORS.text }}>
            Review queue{pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
          </h1>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs"
              style={{ borderColor: COLORS.border, color: COLORS.text }}
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
            <button
              onClick={() => signOut()}
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs"
              style={{ borderColor: COLORS.border, color: COLORS.dim }}
            >
              <LogOut size={13} /> Sign out
            </button>
          </div>
        </div>

        {/* Timeline (migrations 0045/0046/0047): every field generates at
            15:00 UTC (~11am ET) as pending. Review here any time before
            07:00 UTC (~3am ET) the next morning, when anything still
            pending auto-approves on its own — review is a real window,
            not a hard gate, so a day it's skipped still reaches the hero
            page and the 09:00 UTC digest with fresh content instead of
            falling back to stale. */}
        <p className="text-xs mb-6" style={{ color: COLORS.dim }}>
          New picks land here around 11am ET. Anything still pending auto-approves at ~3am ET the next morning, before
          the digest sends — review is optional, not required for fresh content to go out.
        </p>

        {error && (
          <div
            className="flex items-center gap-2 rounded-xl border p-4 mb-6 text-sm"
            style={{ borderColor: COLORS.bad, color: COLORS.bad }}
          >
            <AlertCircle size={15} /> {error}
          </div>
        )}

        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin" style={{ color: COLORS.dim }} />
          </div>
        ) : rows.length === 0 && !error ? (
          <div className="text-sm py-12 text-center" style={{ color: COLORS.dim }}>
            Nothing waiting for review.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.length > 0 && pendingCount > 0 && (
              <button
                onClick={approveAll}
                disabled={busyId !== null}
                className="self-start rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-40 mb-1"
                style={{ backgroundColor: COLORS.accent, color: "#14100C" }}
              >
                Approve all
              </button>
            )}
            {rows.map((row) => (
              <ReviewCard key={row.id} row={row} onDecide={decide} busy={busyId === row.id || busyId === "all"} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
