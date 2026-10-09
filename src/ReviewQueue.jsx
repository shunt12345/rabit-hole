import { useEffect, useState } from "react";
import { Loader2, AlertCircle, RefreshCw, LogOut, Check, X, Sparkles } from "lucide-react";
import { getCurrentUser, onAuthStateChange, sendMagicLink, signOut, getAccessToken } from "./lib/auth.js";

// Mirrors admin-review-queue's own SUGGESTIBLE_FIELDS allowlist — every
// field slot "suggest a topic" (below) can seed. Kept as a literal copy
// here, not fetched from the server, since it's a fixed, rarely-changing
// list and this page already has no other reason to round-trip before
// showing the form.
const SUGGESTIBLE_FIELDS = [
  "Trending 1",
  "Trending 2",
  "This Day In History",
  "Word Of The Day",
  "Quote Of The Day",
  "Riddle",
  "Perspective",
];

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
function ReviewCard({ row, onDecide, busy, replaces }) {
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
            {row.publish_at && !isRejected && (
              <span style={{ color: COLORS.text }}>
                {" · goes live "}
                {new Date(row.publish_at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
              </span>
            )}
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
            <Check size={13} /> {replaces ? "Replace" : "Approve"}
          </button>
          {!isRejected && (
            <button
              onClick={() => onDecide(row.id, "reject")}
              disabled={busy}
              className="flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs disabled:opacity-40"
              style={{ borderColor: COLORS.bad, color: COLORS.bad }}
            >
              {/* Rejecting also fires a fresh generation for this same
                  field (see admin-review-queue's regenerateField), so it
                  takes noticeably longer than approving — worth its own
                  label rather than leaving the button just looking stuck. */}
              <X size={13} /> {busy ? "Rejecting…" : "Reject"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Tomorrow's hero, card by card: the pick approved for the next slot, or
// how many are waiting for review, or a nudge that there's nothing yet.
function SlotChecklist({ slot, fields, approved, rows }) {
  if (!slot || !fields.length) return null;
  const byField = new Map(approved.map((r) => [r.field, r]));
  const done = fields.filter((f) => byField.has(f)).length;
  const complete = done === fields.length;
  const when = new Date(slot).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
  return (
    <div
      className="rounded-2xl border p-4 mb-6"
      style={{ backgroundColor: COLORS.card, borderColor: complete ? COLORS.accent : COLORS.border }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold" style={{ color: COLORS.text }}>
          Tomorrow's hero · goes live {when}
        </div>
        <div className="rh-mono text-xs" style={{ color: complete ? COLORS.accent : COLORS.dim }}>
          {done}/{fields.length} approved
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {fields.map((f) => {
          const pick = byField.get(f);
          const waiting = rows.filter((r) => r.field === f).length;
          return (
            <div key={f} className="flex items-baseline gap-2 text-sm">
              <span className="shrink-0" style={{ color: pick ? COLORS.accent : COLORS.dim }}>
                {pick ? <Check size={13} /> : "○"}
              </span>
              <span className="rh-mono text-xs uppercase tracking-wider shrink-0 w-36" style={{ color: COLORS.dim }}>
                {f}
              </span>
              <span className="min-w-0 truncate" style={{ color: pick ? COLORS.text : waiting ? COLORS.accent : COLORS.bad }}>
                {pick ? pick.topic : waiting ? `${waiting} waiting for review` : "Nothing yet — generate or suggest one"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-xs mt-3" style={{ color: COLORS.dim }}>
        {complete
          ? "All set — tomorrow's hero is locked in and leftovers are cleared."
          : "Approving a pick schedules it for this slot (approving another for the same card replaces it). Once every card is approved, the leftover picks are deleted. Cards still open at 07:00 UTC get their newest pick automatically."}
      </p>
    </div>
  );
}

export default function ReviewQueue() {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = signed out
  const [email, setEmail] = useState("");
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [authError, setAuthError] = useState(null);

  const [rows, setRows] = useState([]);
  const [slot, setSlot] = useState(null);
  const [slotApproved, setSlotApproved] = useState([]);
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Separate from `error` — a soft notice (e.g. a reject's automatic
  // replacement generation failing) that doesn't mean the action itself
  // failed, just that part of what it tried to do didn't go through.
  const [info, setInfo] = useState(null);
  // Which row id (or "all" for the bulk action) currently has an
  // in-flight approve/reject call — disables just that row's buttons
  // rather than freezing the whole queue while one decision is saving.
  const [busyId, setBusyId] = useState(null);

  // "Suggest a topic" — its own small form, own state, independent of the
  // list above. suggesting is a separate busy flag from busyId since this
  // can run alongside the existing queue (nothing here is a row decision).
  const [suggestField, setSuggestField] = useState(SUGGESTIBLE_FIELDS[0]);
  const [suggestText, setSuggestText] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState(null);

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
      const data = await call("list");
      setRows(data.rows || []);
      setSlot(data.slot || null);
      setSlotApproved(data.approved || []);
      setFields(data.fields || []);
    } catch (e) {
      setError(e.message === "__forbidden__" ? "This account isn't on the admin allowlist." : e.message || "Failed to load the review queue.");
    } finally {
      setLoading(false);
    }
  };

  const decide = async (id, action) => {
    setBusyId(id);
    setInfo(null);
    try {
      const result = await call(action, { id });
      // A reject also fires a fresh generation for that same field (see
      // admin-review-queue's regenerateField) — this is why a reject can
      // take noticeably longer than an approve. Surface a failure there
      // as an informational note, not an error: the reject itself still
      // succeeded, the field just goes back to waiting on the next
      // scheduled run instead of having an immediate replacement to
      // review.
      if (action === "approve" && result?.complete) {
        setInfo(`Every card is approved for tomorrow.${result.cleaned ? ` Cleared ${result.cleaned} leftover pick${result.cleaned === 1 ? "" : "s"}.` : ""}`);
      }
      if (action === "reject" && result?.regenerated && !result.regenerated.ok) {
        setInfo(`Rejected — couldn't generate a replacement (${result.regenerated.error || "unknown error"}). It'll pick up on the next scheduled run.`);
      }
      await load();
    } catch (e) {
      setError(e.message || "That decision didn't save — try again.");
    } finally {
      setBusyId(null);
    }
  };

  // A whole new batch for every field, outside the 15:00 UTC schedule —
  // runs in the background (a couple of minutes), so the queue reloads
  // itself a few times to pick the new rows up as they land.
  const generateBatch = async () => {
    if (!window.confirm("Generate a new batch for every field? It takes about 3 minutes, and the picks go live at the next 07:00 UTC once approved.")) return;
    setBusyId("batch");
    setError(null);
    try {
      await call("generateBatch");
      setInfo("Generating a new batch — new picks will appear here over the next few minutes.");
      [60, 120, 180, 240].forEach((s) => setTimeout(load, s * 1000));
    } catch (e) {
      setError(e.message || "Couldn't start a new batch — try again.");
    } finally {
      setBusyId(null);
    }
  };

  const approveAll = async () => {
    setBusyId("all");
    try {
      const result = await call("approveAll");
      if (result?.complete) {
        setInfo(`Every card is approved for tomorrow.${result.cleaned ? ` Cleared ${result.cleaned} leftover pick${result.cleaned === 1 ? "" : "s"}.` : ""}`);
      }
      await load();
    } catch (e) {
      setError(e.message || "Approve all didn't go through — try again.");
    } finally {
      setBusyId(null);
    }
  };

  // Runs the same generateForField path a reject's automatic replacement
  // does (admin-review-queue's regenerateField, now also accepting a
  // suggestion), just triggered on demand with a raw idea instead of after
  // a reject — so it takes the same ~minute-ish real Claude-call time, not
  // an instant save, which is why this gets its own loading state/copy
  // rather than reusing busyId's row-level "saving" framing.
  const suggest = async (e) => {
    e.preventDefault();
    if (!suggestText.trim()) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      await call("suggest", { field: suggestField, suggestion: suggestText.trim() });
      setSuggestText("");
      await load();
    } catch (e) {
      setSuggestError(e.message === "__forbidden__" ? "This account isn't on the admin allowlist." : e.message || "Couldn't generate that suggestion — try again.");
    } finally {
      setSuggesting(false);
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
          New picks land here around 11am ET. Approved picks go live at ~3am ET the next morning, not when you approve them.
          Any card still open then gets its newest pick automatically.
        </p>

        <SlotChecklist slot={slot} fields={fields} approved={slotApproved} rows={rows} />

        <form
          onSubmit={suggest}
          className="rounded-2xl border p-4 mb-6 flex flex-wrap items-end gap-3"
          style={{ backgroundColor: COLORS.card, borderColor: COLORS.border }}
        >
          <label className="text-xs" style={{ color: COLORS.dim }}>
            Suggest a topic for
            <select
              value={suggestField}
              onChange={(e) => setSuggestField(e.target.value)}
              disabled={suggesting}
              className="block mt-1 rounded-lg border px-2 py-1.5 text-sm"
              style={{ backgroundColor: COLORS.bg, borderColor: COLORS.border, color: COLORS.text }}
            >
              {SUGGESTIBLE_FIELDS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs flex-1 min-w-[200px]" style={{ color: COLORS.dim }}>
            Idea
            <input
              type="text"
              value={suggestText}
              onChange={(e) => setSuggestText(e.target.value)}
              disabled={suggesting}
              placeholder="e.g. the James Webb telescope's latest find"
              maxLength={300}
              className="block mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
              style={{ backgroundColor: COLORS.bg, borderColor: COLORS.border, color: COLORS.text }}
            />
          </label>
          <button
            type="submit"
            disabled={suggesting || !suggestText.trim()}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
            style={{ backgroundColor: COLORS.accent, color: "#14100C" }}
          >
            {suggesting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {suggesting ? "Writing…" : "Generate"}
          </button>
          {suggestError && (
            <div className="basis-full flex items-center gap-1.5 text-xs" style={{ color: COLORS.bad }}>
              <AlertCircle size={13} /> {suggestError}
            </div>
          )}
        </form>

        {info && (
          <div
            className="flex items-center gap-2 rounded-xl border p-4 mb-6 text-sm"
            style={{ borderColor: COLORS.border, color: COLORS.dim, backgroundColor: COLORS.card }}
          >
            <AlertCircle size={15} /> {info}
          </div>
        )}

        {error && (
          <div
            className="flex items-center gap-2 rounded-xl border p-4 mb-6 text-sm"
            style={{ borderColor: COLORS.bad, color: COLORS.bad }}
          >
            <AlertCircle size={15} /> {error}
          </div>
        )}

        <button
          onClick={generateBatch}
          disabled={busyId !== null}
          className="rounded-full border px-3 py-1.5 text-xs font-medium disabled:opacity-40 mb-4"
          style={{ borderColor: COLORS.accent, color: COLORS.accent }}
        >
          Generate new batch
        </button>

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
                Approve all open cards
              </button>
            )}
            {rows.map((row) => (
              <ReviewCard
                key={row.id}
                row={row}
                onDecide={decide}
                busy={busyId === row.id || busyId === "all"}
                replaces={slotApproved.some((a) => a.field === row.field)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
