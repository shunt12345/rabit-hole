import { useEffect, useState } from "react";
import { Loader2, AlertCircle, RefreshCw, LogOut, Eye } from "lucide-react";
import { getCurrentUser, onAuthStateChange, sendMagicLink, signOut, getAccessToken } from "./lib/auth.js";
import MiniGauge from "./MiniGauge.jsx";
import { streamTextFromPrompt } from "./lib/api.js";
import { HYFAX_SYSTEM } from "./lib/hyfaxSystemPrompt.js";
import { articleUserPrompt, ARTICLE_MAX_TOKENS } from "./lib/articlePrompt.js";

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

// Tone Lab: the same topic page article from each model, side by side,
// labelled A/B/C in a shuffled order until revealed, so the voice can be
// judged before knowing which model wrote it. Every model gets the exact
// same prompt (one articleUserPrompt call per run, so even the assigned
// second-paragraph opener matches). The proxy only honours modelOverride
// for an ADMIN_USER_IDS account.
const TONE_LAB_MODELS = [
  { id: "claude-sonnet-5", name: "Sonnet 5 (current)" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5" },
  { id: "claude-haiku-5-5", name: "Haiku 5.5" },
];

function splitTitle(raw) {
  const m = (raw || "").match(/^\s*TITLE:\s*(.*)\n+/);
  return m ? { title: m[1].trim(), body: raw.slice(m[0].length) } : { title: null, body: raw || "" };
}

// Same rule as the live app: a capped article ends at its last complete
// sentence, so the comparison shows what a reader would actually see.
function trimToLastSentence(text) {
  const t = (text || "").trimEnd();
  if (/[.!?]["'”’)\]]*$/.test(t)) return t;
  let cut = -1;
  for (const m of t.matchAll(/[.!?]["'”’)\]]*(?=\s)/g)) cut = m.index + m[0].length;
  return cut > 0 ? t.slice(0, cut) : t;
}

function ToneLabText({ text }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed" style={{ color: COLORS.text }}>
      {text
        .split(/\n\s*\n/)
        .filter((p) => p.trim())
        .map((para, i) => (
          <p key={i}>
            {para.split(/(\[\[[^[\]]+?\]\])/).map((piece, j) =>
              /^\[\[.*\]\]$/.test(piece) ? (
                <span key={j} style={{ color: COLORS.accent, textDecoration: "underline", textDecorationStyle: "dotted" }}>
                  {piece.slice(2, -2)}
                </span>
              ) : (
                <span key={j}>{piece}</span>
              )
            )}
          </p>
        ))}
    </div>
  );
}

function ToneLab() {
  const [topic, setTopic] = useState("");
  const [runs, setRuns] = useState([]);
  const [revealed, setRevealed] = useState(false);
  const running = runs.some((r) => r.loading);

  const generate = (e) => {
    e.preventDefault();
    const t = topic.trim();
    if (!t || running) return;
    setRevealed(false);
    const prompt = articleUserPrompt({ topicLabel: t, path: [t], nodeType: "root" });
    const order = [...TONE_LAB_MODELS].sort(() => Math.random() - 0.5);
    const initial = order.map((m, i) => ({ ...m, slot: "ABC"[i], text: "", ttftMs: null, totalMs: null, error: null, loading: true }));
    setRuns(initial);
    initial.forEach((run) => {
      const startedAt = performance.now();
      let firstAt = null;
      const update = (patch) => setRuns((prev) => prev.map((r) => (r.slot === run.slot ? { ...r, ...patch } : r)));
      streamTextFromPrompt(
        HYFAX_SYSTEM,
        prompt,
        ARTICLE_MAX_TOKENS,
        60000,
        "article",
        (partial) => {
          if (firstAt == null) {
            firstAt = performance.now();
            update({ ttftMs: firstAt - startedAt });
          }
          update({ text: partial });
        },
        "root",
        undefined,
        undefined,
        undefined,
        undefined,
        { modelOverride: run.id }
      )
        .then((finalText) => update({ text: finalText, totalMs: performance.now() - startedAt, loading: false }))
        .catch((err) => update({ error: err.message || "Generation failed", loading: false }));
    });
  };

  return (
    <div className="rounded-2xl border p-4 mb-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
      <form onSubmit={generate} className="flex flex-wrap items-end gap-3 mb-4">
        <label className="text-xs flex-1 min-w-[220px]" style={{ color: COLORS.dim }}>
          Topic
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="why do cats knead"
            className="block mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
            style={{ backgroundColor: COLORS.bg, borderColor: COLORS.border, color: COLORS.text }}
          />
        </label>
        <button
          type="submit"
          disabled={running || !topic.trim()}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
          style={{ backgroundColor: COLORS.accent, color: "#14100C" }}
        >
          {running && <Loader2 size={14} className="animate-spin" />} Compare
        </button>
        {runs.length > 0 && !running && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm"
            style={{ borderColor: COLORS.border, color: COLORS.text }}
          >
            <Eye size={14} /> {revealed ? "Hide models" : "Reveal models"}
          </button>
        )}
      </form>
      {runs.length > 0 && (
        <div className="grid md:grid-cols-3 gap-3">
          {runs.map((r) => {
            const { title, body } = splitTitle(r.text);
            const shown = r.loading ? body : trimToLastSentence(body);
            const words = shown.split(/\s+/).filter(Boolean).length;
            return (
              <div key={r.slot} className="rounded-xl border p-3" style={{ borderColor: COLORS.border, backgroundColor: COLORS.bg }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="rh-mono rh-text-10 uppercase tracking-wider" style={{ color: COLORS.accent }}>
                    {r.slot}
                    {revealed ? ` · ${r.name}` : ""}
                  </span>
                  {r.loading && <Loader2 size={13} className="animate-spin" style={{ color: COLORS.dim }} />}
                </div>
                <div className="text-xs mb-3" style={{ color: COLORS.dim }}>
                  first words {r.ttftMs != null ? `${(r.ttftMs / 1000).toFixed(1)}s` : "…"} · done{" "}
                  {r.totalMs != null ? `${(r.totalMs / 1000).toFixed(1)}s` : "…"} · {words} words
                </div>
                {title && (
                  <div className="rh-display italic text-lg mb-2" style={{ color: COLORS.text }}>
                    {title}
                  </div>
                )}
                {r.error ? (
                  <div className="flex items-center gap-1.5 text-xs" style={{ color: COLORS.bad }}>
                    <AlertCircle size={13} /> {r.error}
                  </div>
                ) : (
                  <ToneLabText text={shown} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

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

function usd2(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function pct(n) {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

// Default Adoption date range — 28 days, enough to see a full retention
// cohort's Day 7 column fill in without the query spanning months of
// visitors by default.
function defaultSince() {
  return new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function defaultUntil() {
  return new Date().toISOString().slice(0, 10);
}

export default function AdminDashboard() {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = signed out
  const [email, setEmail] = useState("");
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [authError, setAuthError] = useState(null);

  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Adoption section (visitors/sessions/events — migration 0049) — its own
  // fetch, filters, and loading/error state, entirely separate from the
  // usage-stats panels above (different edge function, different table
  // set, own date range rather than a handful of fixed windows).
  const [adoptionFilters, setAdoptionFilters] = useState({
    source: "",
    campaign: "",
    since: defaultSince(),
    until: defaultUntil(),
    includeTest: false,
  });
  const [adoptionStats, setAdoptionStats] = useState(null);
  const [adoptionLoading, setAdoptionLoading] = useState(false);
  const [adoptionError, setAdoptionError] = useState(null);
  const [adSpend, setAdSpend] = useState("");

  const loadAdoptionStats = async (filters) => {
    setAdoptionLoading(true);
    setAdoptionError(null);
    try {
      const token = await getAccessToken();
      const params = new URLSearchParams();
      if (filters.source) params.set("source", filters.source);
      if (filters.campaign) params.set("campaign", filters.campaign);
      if (filters.since) params.set("since", new Date(filters.since).toISOString());
      if (filters.until) params.set("until", new Date(filters.until + "T23:59:59").toISOString());
      if (filters.includeTest) params.set("includeTest", "1");
      const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-adoption-stats?${params.toString()}`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
      });
      if (res.status === 403) {
        setAdoptionError("This account isn't on the admin allowlist.");
        return;
      }
      if (!res.ok) {
        setAdoptionError(`Request failed (${res.status}).`);
        return;
      }
      setAdoptionStats(await res.json());
    } catch (e) {
      setAdoptionError(e.message || "Failed to load adoption stats.");
    } finally {
      setAdoptionLoading(false);
    }
  };

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

  useEffect(() => {
    if (user) loadAdoptionStats(adoptionFilters);
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

        <p className="text-xs mb-4" style={{ color: COLORS.dim }}>
          Your own signed-in activity is excluded from every number below except the 24h cap gauge, which mirrors the
          real enforced limit. Testing done while signed out can't be told apart from a real anonymous visitor.
        </p>

        {/* The review queue (pending/rejected trending_topics_cache rows)
            now lives at its own page, /queue (see ReviewQueue.jsx) — this
            dashboard stays focused on usage stats. */}

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

        <div className="flex items-center justify-between mt-10 mb-4">
          <h2 className="rh-display text-xl" style={{ color: COLORS.text }}>
            Adoption
          </h2>
          <button
            onClick={() => loadAdoptionStats(adoptionFilters)}
            disabled={adoptionLoading}
            className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs"
            style={{ borderColor: COLORS.border, color: COLORS.text }}
          >
            <RefreshCw size={13} className={adoptionLoading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        <div
          className="rounded-2xl border p-4 mb-6 flex flex-wrap items-end gap-3"
          style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}
        >
          <label className="text-xs" style={{ color: COLORS.dim }}>
            Source
            <select
              value={adoptionFilters.source}
              onChange={(e) => setAdoptionFilters((f) => ({ ...f, source: e.target.value }))}
              className="block mt-1 rounded-lg border px-2 py-1.5 text-sm"
              style={{ backgroundColor: COLORS.bg, borderColor: COLORS.border, color: COLORS.text }}
            >
              <option value="">All</option>
              <option value="reddit">Reddit</option>
              <option value="direct">Direct</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="text-xs" style={{ color: COLORS.dim }}>
            Campaign (utm_campaign)
            <input
              type="text"
              value={adoptionFilters.campaign}
              onChange={(e) => setAdoptionFilters((f) => ({ ...f, campaign: e.target.value }))}
              placeholder="kitchen-crystals"
              className="block mt-1 rounded-lg border px-2 py-1.5 text-sm"
              style={{ backgroundColor: COLORS.bg, borderColor: COLORS.border, color: COLORS.text }}
            />
          </label>
          <label className="text-xs" style={{ color: COLORS.dim }}>
            Since
            <input
              type="date"
              value={adoptionFilters.since}
              onChange={(e) => setAdoptionFilters((f) => ({ ...f, since: e.target.value }))}
              className="block mt-1 rounded-lg border px-2 py-1.5 text-sm"
              style={{ backgroundColor: COLORS.bg, borderColor: COLORS.border, color: COLORS.text }}
            />
          </label>
          <label className="text-xs" style={{ color: COLORS.dim }}>
            Until
            <input
              type="date"
              value={adoptionFilters.until}
              onChange={(e) => setAdoptionFilters((f) => ({ ...f, until: e.target.value }))}
              className="block mt-1 rounded-lg border px-2 py-1.5 text-sm"
              style={{ backgroundColor: COLORS.bg, borderColor: COLORS.border, color: COLORS.text }}
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs" style={{ color: COLORS.dim }}>
            <input
              type="checkbox"
              checked={adoptionFilters.includeTest}
              onChange={(e) => setAdoptionFilters((f) => ({ ...f, includeTest: e.target.checked }))}
            />
            Include my own testing
          </label>
          <button
            onClick={() => loadAdoptionStats(adoptionFilters)}
            disabled={adoptionLoading}
            className="rounded-lg px-3 py-1.5 text-sm font-medium"
            style={{ backgroundColor: COLORS.accent, color: "#14100C" }}
          >
            Apply
          </button>
        </div>

        {adoptionError && (
          <div
            className="flex items-center gap-2 rounded-xl border p-4 mb-6 text-sm"
            style={{ borderColor: COLORS.bad, color: COLORS.bad }}
          >
            <AlertCircle size={15} /> {adoptionError}
          </div>
        )}

        {adoptionStats && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <StatCard label="Landed" value={adoptionStats.funnel.landed} />
              <StatCard
                label="Activated"
                value={adoptionStats.funnel.activated}
                sub={`${pct(adoptionStats.funnel.activatedPct)} of landed`}
              />
              <StatCard label="Deep" value={adoptionStats.funnel.deep} sub={`${pct(adoptionStats.funnel.deepPct)} of landed`} />
              <StatCard
                label="Signed up"
                value={adoptionStats.funnel.signedUp}
                sub={`${pct(adoptionStats.funnel.signedUpPct)} of landed`}
              />
            </div>

            <div className="grid md:grid-cols-2 gap-4 mb-6">
              <div className="rounded-2xl border p-4" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
                <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                  Depth
                </div>
                <div className="text-sm" style={{ color: COLORS.text }}>
                  Avg {adoptionStats.depth.avgPagesPerSession.toFixed(1)} pages/session · Median{" "}
                  {adoptionStats.depth.medianPagesPerSession.toFixed(1)}
                </div>
                <div className="text-xs mt-1" style={{ color: COLORS.dim }}>
                  Across {adoptionStats.depth.sessionCount} session{adoptionStats.depth.sessionCount === 1 ? "" : "s"}
                </div>
              </div>

              <div className="rounded-2xl border p-4" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
                <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                  North star — weekly 3+ page visitors
                </div>
                <div className="rh-display text-2xl" style={{ color: COLORS.text }}>
                  {adoptionStats.northStar.thisWeekCount}
                </div>
                <div className="text-xs mt-1" style={{ color: COLORS.dim }}>
                  {adoptionStats.northStar.changePct == null
                    ? `${adoptionStats.northStar.lastWeekCount} last week`
                    : `${adoptionStats.northStar.changePct >= 0 ? "+" : ""}${Math.round(
                        adoptionStats.northStar.changePct * 100
                      )}% vs. last week (${adoptionStats.northStar.lastWeekCount})`}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border p-4 mb-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
              <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                Cost helper
              </div>
              <label className="text-xs block mb-3" style={{ color: COLORS.dim }}>
                Ad spend for this filter
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={adSpend}
                  onChange={(e) => setAdSpend(e.target.value)}
                  placeholder="0.00"
                  className="block mt-1 rounded-lg border px-2 py-1.5 text-sm w-40"
                  style={{ backgroundColor: COLORS.bg, borderColor: COLORS.border, color: COLORS.text }}
                />
              </label>
              {Number(adSpend) > 0 ? (
                <Table
                  columns={[
                    { key: "stage", label: "Stage" },
                    { key: "count", label: "Visitors" },
                    { key: "cost", label: "Cost/visitor", render: (r) => (r.count ? usd2(Number(adSpend) / r.count) : "—") },
                  ]}
                  rows={[
                    { stage: "Landed", count: adoptionStats.funnel.landed },
                    { stage: "Activated", count: adoptionStats.funnel.activated },
                    { stage: "Deep", count: adoptionStats.funnel.deep },
                    { stage: "Signed up", count: adoptionStats.funnel.signedUp },
                  ]}
                  emptyText="No funnel data for this filter."
                />
              ) : (
                <div className="text-xs" style={{ color: COLORS.dim }}>
                  Enter ad spend above to see cost per landed/activated/deep/signed-up visitor for the selected filters.
                </div>
              )}
            </div>

            <div className="rounded-2xl border p-4 mb-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
              <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                New vs. returning visitors per day
              </div>
              <Table
                columns={[
                  { key: "day", label: "Day" },
                  { key: "new", label: "New" },
                  { key: "returning", label: "Returning" },
                ]}
                rows={adoptionStats.newVsReturning}
                emptyText="No activity in this date range."
              />
            </div>

            <div className="rounded-2xl border p-4 mb-6" style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}>
              <div className="rh-mono rh-text-10 uppercase tracking-wider mb-2" style={{ color: COLORS.dim }}>
                Retention cohort (America/New York)
              </div>
              <Table
                columns={[
                  { key: "week", label: "First-seen week" },
                  { key: "cohortSize", label: "Cohort" },
                  { key: "day1Pct", label: "Day 1", render: (r) => pct(r.day1Pct) },
                  { key: "day7Pct", label: "Day 7", render: (r) => pct(r.day7Pct) },
                  { key: "day30Pct", label: "Day 30", render: (r) => pct(r.day30Pct) },
                ]}
                rows={adoptionStats.retentionCohort}
                emptyText="No cohorts in this date range."
              />
            </div>
          </>
        )}

        <div className="flex items-baseline justify-between mt-10 mb-4">
          <h2 className="rh-display text-xl" style={{ color: COLORS.text }}>
            Tone Lab
          </h2>
          <span className="text-xs" style={{ color: COLORS.dim }}>
            Same prompt, three models, names hidden until revealed
          </span>
        </div>
        <ToneLab />
      </div>
    </div>
  );
}
