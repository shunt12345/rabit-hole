import { useEffect, useState } from "react";
import { Loader2, AlertCircle, RefreshCw, LogOut } from "lucide-react";
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

export default function AdminDashboard() {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = signed out
  const [email, setEmail] = useState("");
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [authError, setAuthError] = useState(null);

  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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

  useEffect(() => {
    if (user) loadStats();
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
              onClick={loadStats}
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
