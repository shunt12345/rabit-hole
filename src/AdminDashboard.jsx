import { useEffect, useState } from "react";
import { Loader2, AlertCircle, RefreshCw, LogOut, Check, X } from "lucide-react";
import { getCurrentUser, onAuthStateChange, sendMagicLink, signOut, getAccessToken } from "./lib/auth.js";
import MiniGauge from "./MiniGauge.jsx";

// Served at /admin (see main.jsx) — a completely separate mount from the
// main Hyfax app, not a route inside it, since this app has no router and
// bolting a second view onto App.jsx's already-large render tree for one
// operator-only page wasn't worth it. Same auth (magic link) as the main
// app, but a real access check happens server-side in admin-usage-stats —
// this page itself enforces nothing; it just won't have anything to show
// if the signed-in account isn't on that function's ADMIN_USER_IDS
// allowlist.
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

function StatCard({ label, value, sub }) {
  return (
    <div className="rounded-2xl border p-4" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
      <div className="rh-mono rh-text-10 uppercase tracking-wider mb-1" style={{ color: COLORS.dim }}>
        {label}
      </div>
      <div className="rh-display text-2xl" style={{ color: COLORS.text }}>
        {value}
      </div>
      {sub && (
        <div className="text-xs mt-1" style={{ color: COLORS.dim }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Table({ columns, rows, emptyText }) {
  if (!rows.length) {
    return (
      <div className="text-sm py-4 text-center" style={{ color: COLORS.dim }}>
        {emptyText}
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
          {columns.map((c) => (
            <th key={c.key} className="text-left py-2 pr-4 rh-mono rh-text-10 uppercase tracking-wider" style={{ color: COLORS.dim }}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${COLORS.border}` : "none" }}>
            {columns.map((c) => (
              <td key={c.key} className="py-2 pr-4" style={{ color: COLORS.text }}>
                {c.render ? c.render(row) : row[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function usd(n) {
  return `$${Number(n || 0).toFixed(4)}`;
}

// One pending/rejected trending_topics_cache row, with its own
// approve/reject buttons — deliberately a plain card per row rather than
// a Table (above), since a teaser can run to a full sentence or two and a
// table cell would truncate or wrap awkwardly compared to a card's full
// width.
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

export default function AdminDashboard() {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = signed out
  const [email, setEmail] = useState("");
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [authError, setAuthError] = useState(null);

  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Review queue (trending_topics_cache rows awaiting a decision before
  // generate-trending-topics' output reaches the public hero page/digest
  // — see migration 0045 + admin-review-queue). Separate loading/error
  // state from the usage stats above since these two sections load
  // independently and a failure in one shouldn't block the other.
  const [reviewRows, setReviewRows] = useState([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState(null);
  // Which row id (or "all" for the bulk action) currently has an
  // in-flight approve/reject call — disables just that row's buttons
  // rather than freezing the whole queue while one decision is saving.
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    getCurrentUser().then(setUser);
    return onAuthStateChange(setUser);
  }, []);

  const loadStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-usage-stats`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
      });
      if (res.status === 403) {
        setError("This account isn't on the admin allowlist.");
        return;
      }
      if (!res.ok) {
        setError(`Request failed (${res.status}).`);
        return;
      }
      setStats(await res.json());
    } catch (e) {
      setError(e.message || "Failed to load usage stats.");
    } finally {
      setLoading(false);
    }
  };

  const callReviewQueue = async (action, extra) => {
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
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status}).`);
    }
    return res.json();
  };

  const loadReviewQueue = async () => {
    setReviewLoading(true);
    setReviewError(null);
    try {
      const { rows } = await callReviewQueue("list");
      setReviewRows(rows || []);
    } catch (e) {
      setReviewError(e.message || "Failed to load the review queue.");
    } finally {
      setReviewLoading(false);
    }
  };

  const decide = async (id, action) => {
    setBusyId(id);
    try {
      await callReviewQueue(action, { id });
      await loadReviewQueue();
    } catch (e) {
      setReviewError(e.message || "That decision didn't save — try again.");
    } finally {
      setBusyId(null);
    }
  };

  const approveAll = async () => {
    setBusyId("all");
    try {
      await callReviewQueue("approveAll");
      await loadReviewQueue();
    } catch (e) {
      setReviewError(e.message || "Approve all didn't go through — try again.");
    } finally {
      setBusyId(null);
    }
  };

  useEffect(() => {
    if (user) {
      loadStats();
      loadReviewQueue();
    }
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
            Hyfax Admin
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

  return (
    <div className="min-h-screen px-5 py-8" style={{ backgroundColor: COLORS.bg }}>
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="rh-display text-2xl" style={{ color: COLORS.text }}>
            Hyfax Admin
          </h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                loadStats();
                loadReviewQueue();
              }}
              disabled={loading || reviewLoading}
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs"
              style={{ borderColor: COLORS.border, color: COLORS.text }}
            >
              <RefreshCw size={13} className={loading || reviewLoading ? "animate-spin" : ""} /> Refresh
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

        <p className="text-xs mb-4" style={{ color: COLORS.dim }}>
          Your own signed-in activity is excluded from every number below except the 24h cap gauge, which mirrors the
          real enforced limit. Testing done while signed out can't be told apart from a real anonymous visitor.
        </p>

        {/* Review queue — the evergreen/date-anchored batch (This Day In
            History, Word Of The Day, Quote, Riddle, Perspective) sits here
            as status='pending' (migration 0045) from the 15:00 UTC
            generation run until the admin approves/rejects it, or until a
            third cron job auto-approves anything still pending at 07:00
            UTC the next morning (migration 0046) — review is a real
            window, not a hard gate, so a day it's skipped still reaches
            the hero page and the 09:00 UTC digest with fresh content
            instead of falling back to stale. Trending news isn't gated at
            all (see generate-trending-topics' `needsReview` check) and
            never shows up here. Placed above the usage stats since this is
            the actually time-sensitive part of the page. */}
        <div className="rounded-2xl border p-4 mb-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
          <div className="flex items-center justify-between mb-1">
            <div className="rh-mono rh-text-10 uppercase tracking-wider" style={{ color: COLORS.dim }}>
              Review queue{reviewRows.some((r) => r.status === "pending") ? ` · ${reviewRows.filter((r) => r.status === "pending").length} pending` : ""}
            </div>
            {reviewRows.some((r) => r.status === "pending") && (
              <button
                onClick={approveAll}
                disabled={busyId !== null}
                className="rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                style={{ backgroundColor: COLORS.accent, color: "#14100C" }}
              >
                Approve all
              </button>
            )}
          </div>
          <p className="text-xs mb-3" style={{ color: COLORS.dim }}>
            New picks land here around 11am ET. Anything still pending auto-approves at ~3am ET the next morning, before
            the digest sends — review is optional, not required for fresh content to go out.
          </p>

          {reviewError && (
            <div className="flex items-center gap-2 text-sm mb-3" style={{ color: COLORS.bad }}>
              <AlertCircle size={15} /> {reviewError}
            </div>
          )}

          {reviewLoading && reviewRows.length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={18} className="animate-spin" style={{ color: COLORS.dim }} />
            </div>
          ) : reviewRows.length === 0 ? (
            <div className="text-sm py-4 text-center" style={{ color: COLORS.dim }}>
              Nothing waiting for review.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {reviewRows.map((row) => (
                <ReviewCard key={row.id} row={row} onDecide={decide} busy={busyId === row.id || busyId === "all"} />
              ))}
            </div>
          )}
        </div>

        {error && (
          <div
            className="flex items-center gap-2 rounded-xl border p-4 mb-6 text-sm"
            style={{ borderColor: COLORS.bad, color: COLORS.bad }}
          >
            <AlertCircle size={15} /> {error}
          </div>
        )}

        {stats && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <StatCard label="Requests today" value={stats.daily[0]?.requests ?? 0} />
              <StatCard label="Unique sessions today" value={stats.daily[0]?.uniqueSessions ?? 0} />
              <StatCard label="Spend today" value={usd(stats.daily[0]?.spendUsd)} />
              <StatCard label="New sign-ups today" value={stats.dailySignups[0]?.count ?? 0} />
            </div>

            <div className="rounded-2xl border p-4 mb-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
              <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                Free-tier spend, last 24h
              </div>
              <MiniGauge
                label={`${usd(stats.spendLast24hUsd)} of $${stats.spendCapUsd} cap`}
                fraction={stats.spendCapUsd ? stats.spendLast24hUsd / stats.spendCapUsd : 0}
                color={stats.spendLast24hUsd / stats.spendCapUsd > 0.8 ? COLORS.bad : COLORS.accent}
              />
            </div>

            <div className="rounded-2xl border p-4 mb-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
              <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                Daily trend (last 30 days)
              </div>
              <Table
                columns={[
                  { key: "day", label: "Day" },
                  { key: "requests", label: "Requests" },
                  { key: "uniqueSessions", label: "Sessions" },
                  { key: "spendUsd", label: "Spend", render: (r) => usd(r.spendUsd) },
                ]}
                rows={stats.daily}
                emptyText="No requests logged yet."
              />
            </div>

            <div className="rounded-2xl border p-4 mb-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
              <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                Daily trend by source (last 30 days)
              </div>
              <Table
                columns={[
                  { key: "day", label: "Day" },
                  { key: "channel", label: "Source" },
                  { key: "requests", label: "Requests" },
                  { key: "uniqueSessions", label: "Sessions" },
                  { key: "spendUsd", label: "Spend", render: (r) => usd(r.spendUsd) },
                ]}
                rows={stats.dailyByChannel}
                emptyText="No requests logged yet."
              />
            </div>

            <div className="grid md:grid-cols-2 gap-4 mb-6">
              <div className="rounded-2xl border p-4" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
                <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                  By endpoint (last 7 days)
                </div>
                <Table
                  columns={[
                    { key: "endpoint", label: "Endpoint" },
                    { key: "requests", label: "Requests" },
                    { key: "spendUsd", label: "Spend", render: (r) => usd(r.spendUsd) },
                    { key: "avgLatencyMs", label: "Avg ms", render: (r) => r.avgLatencyMs ?? "—" },
                  ]}
                  rows={stats.byEndpoint}
                  emptyText="No requests in the last 7 days."
                />
              </div>

              <div className="rounded-2xl border p-4" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
                <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                  Signed-in vs. anonymous (last 7 days)
                </div>
                <Table
                  columns={[
                    { key: "signedIn", label: "Who", render: (r) => (r.signedIn ? "Signed in" : "Anonymous") },
                    { key: "requests", label: "Requests" },
                    { key: "spendUsd", label: "Spend", render: (r) => usd(r.spendUsd) },
                  ]}
                  rows={stats.identitySplit}
                  emptyText="No requests in the last 7 days."
                />
              </div>
            </div>

            <div className="rounded-2xl border p-4 mb-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
              <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                Funded vs. free-tier spend (last 7 days)
              </div>
              <Table
                columns={[
                  { key: "tier", label: "Tier" },
                  { key: "requests", label: "Requests" },
                  { key: "spendUsd", label: "Spend", render: (r) => usd(r.spendUsd) },
                ]}
                rows={stats.fundedSplit}
                emptyText="No requests in the last 7 days."
              />
            </div>

            <div className="rounded-2xl border p-4 mb-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
              <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                What people click from the hero page (last 30 days)
              </div>
              <Table
                columns={[
                  { key: "source", label: "Source" },
                  { key: "clicks", label: "Clicks" },
                  { key: "share", label: "Share", render: (r) => `${Math.round(r.share * 100)}%` },
                ]}
                rows={stats.byHeroSource}
                emptyText="No root topics started in the last 30 days."
              />
            </div>

            <div className="rounded-2xl border p-4 mb-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
              <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                What people click, by source (last 30 days)
              </div>
              <Table
                columns={[
                  { key: "channel", label: "Source" },
                  { key: "source", label: "Clicked" },
                  { key: "clicks", label: "Clicks" },
                  { key: "share", label: "Share of that source", render: (r) => `${Math.round(r.share * 100)}%` },
                ]}
                rows={stats.byHeroSourceByChannel}
                emptyText="No root topics started in the last 30 days."
              />
            </div>

            <div className="rounded-2xl border p-4" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
              <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                Top IPs (last 24h)
              </div>
              <Table
                columns={[
                  { key: "ip", label: "IP" },
                  { key: "requests", label: "Requests" },
                ]}
                rows={stats.topIps}
                emptyText="No requests in the last 24h."
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
