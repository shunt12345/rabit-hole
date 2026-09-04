import { useEffect, useState } from "react";
import { X, User as UserIcon } from "lucide-react";
import { sendMagicLink, signOut } from "./lib/auth.js";
import { updateFeatureToggles } from "./lib/profile.js";
import { startCheckout, MIN_TOPUP_USD } from "./lib/billing.js";

// Production punch list, Section C (funded experience) UI pass: a single
// avatar/account button in the header corner, opening a modal with
// balance, add-funds, and the per-feature toggle panel — replaces the
// earlier always-expanded inline bar. The real "Usage" gas-gauge lives on
// the hero page now (see UsageGauge.jsx), not in here. Node count
// ("Explore — 3/4/5 nodes") is deliberately NOT a toggle here — its exact
// mechanics are still an open decision (punch list Section G).
//
// `profile`/`onProfileChange`/`onProfileRefresh` are owned by App.jsx, not
// this component — App.jsx is what actually gates News/Today/Dig Deeper on
// these same toggle values, so it needs the single source of truth, not a
// second copy that could drift out of sync with what's rendered there.
//
// "Email digest" is a placeholder — punch list Section E (the actual
// digest cron job + sending integration) isn't built yet, so toggling
// this doesn't send anything today. It's here so the preference is
// already captured for whenever Section E ships, rather than needing a
// second onboarding moment later. App.jsx does NOT gate anything on it.
const TOGGLES = [
  { key: "featureNews", label: "News" },
  { key: "featureToday", label: "Today" },
  { key: "featureDigDeeper", label: "Dig Deeper" },
  { key: "featureEmail", label: "Email digest", placeholder: true },
];

// Purely illustrative "how much is currently turned on" gauge — NOT the
// real cost-weighted "speed gauge" from Section C (that one's still
// deferred: it needs real per-feature cost weights and the Explore
// node-count decision from Section G before it can show an honest $/hr
// rate). This is simpler and makes no cost claim: Dig In counts as an
// always-on baseline segment, and each optional toggle that's on adds one
// more segment, out of the total optional-toggle count.
const OPTIONAL_TOGGLE_KEYS = TOGGLES.map((t) => t.key);
const THROTTLE_LABELS = ["Idle", "Light", "Moderate", "Cruising", "Full send"];

function lerpColor(hexA, hexB, t) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const ar = (a >> 16) & 255,
    ag = (a >> 8) & 255,
    ab = a & 255;
  const br = (b >> 16) & 255,
    bg = (b >> 8) & 255,
    bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function ThrottleGauge({ profile }) {
  const onCount = OPTIONAL_TOGGLE_KEYS.filter((k) => !!profile?.[k]).length;
  const segments = 1 + OPTIONAL_TOGGLE_KEYS.length; // Dig In baseline + each optional toggle
  const filled = 1 + onCount;
  const fraction = filled / segments;
  const color = lerpColor("#E3A73C", "#D9483C", fraction);
  const label = THROTTLE_LABELS[Math.min(filled - 1, THROTTLE_LABELS.length - 1)];

  // Deliberately slim and low-contrast — a quiet ambient indicator, not
  // another headline stat competing with Balance/Usage above it.
  return (
    <div>
      <div className="flex justify-between rh-mono mb-1" style={{ color: "#6B5B45", fontSize: "9px" }}>
        <span>Throttle</span>
        <span style={{ color }}>{label}</span>
      </div>
      <div className="flex gap-0.5">
        {Array.from({ length: segments }).map((_, i) => (
          <div
            key={i}
            className="flex-1 rounded-full transition-colors"
            style={{ height: "3px", backgroundColor: i < filled ? color : "#3A2E20" }}
          />
        ))}
      </div>
    </div>
  );
}

function Avatar({ email }) {
  const initial = (email || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      className="rh-mono flex items-center justify-center rounded-full font-semibold shrink-0"
      style={{ width: "32px", height: "32px", backgroundColor: "#E3A73C", color: "#14100C", fontSize: "13px" }}
    >
      {initial}
    </div>
  );
}

// iOS-style switch built on a real <button role="switch">, not a styled
// checkbox — flex + justifyContent handles the knob position so there's no
// transform math to get wrong at different sizes.
function Toggle({ checked, disabled, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center shrink-0 transition-colors disabled:opacity-50"
      style={{
        width: "36px",
        height: "20px",
        borderRadius: "999px",
        padding: "2px",
        backgroundColor: checked ? "#E3A73C" : "#3A2E20",
        border: `1px solid ${checked ? "#E3A73C" : "#5A4630"}`,
        justifyContent: checked ? "flex-end" : "flex-start",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <span
        style={{
          width: "14px",
          height: "14px",
          borderRadius: "50%",
          backgroundColor: checked ? "#14100C" : "#A89478",
        }}
      />
    </button>
  );
}

// Click-outside-to-close backdrop + Escape-to-close, centered panel. Fixed
// positioning rather than a portal — simplest thing that works given
// nothing in this app's CSS puts a transform/filter on an ancestor (which
// would otherwise break position:fixed's usual full-viewport behavior).
function Modal({ onClose, children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start md:items-center justify-center p-4 overflow-y-auto"
      style={{ backgroundColor: "rgba(10, 8, 5, 0.7)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-2xl border my-8"
        style={{ maxWidth: "360px", borderColor: "#3A2E20", backgroundColor: "#1F1811" }}
      >
        {children}
      </div>
    </div>
  );
}

export default function AccountMenu({ user, profile, onProfileChange, onProfileRefresh, onLifetimeFundedRefresh }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [modalOpen, setModalOpen] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState(String(MIN_TOPUP_USD));
  const [checkoutStatus, setCheckoutStatus] = useState("idle"); // idle | starting | error | success
  const [toggleSaving, setToggleSaving] = useState(null); // which toggle key is mid-save, if any

  // Stripe redirects back to `/?checkout=success` (or `?checkout=cancel`)
  // after a top-up — see create-checkout-session's success_url/cancel_url.
  // The webhook that actually credits the balance runs asynchronously on
  // Stripe's side, so this waits a moment before re-reading it rather than
  // assuming it's already landed the instant the browser redirects back.
  // Only runs once on mount; the query param is stripped either way so a
  // page refresh doesn't keep re-showing the message. Opens the modal
  // automatically so the updated balance is the first thing seen.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (!checkout) return;
    window.history.replaceState({}, "", window.location.pathname);
    if (checkout === "success") {
      setCheckoutStatus("success");
      setModalOpen(true);
      const timeoutId = setTimeout(() => {
        onProfileRefresh();
        onLifetimeFundedRefresh();
      }, 1500);
      return () => clearTimeout(timeoutId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAddFunds = async (e) => {
    e.preventDefault();
    const amount = Number(topUpAmount);
    if (!Number.isFinite(amount) || amount < MIN_TOPUP_USD) return;
    setCheckoutStatus("starting");
    try {
      await startCheckout(amount);
      // startCheckout redirects the browser away on success — nothing
      // left to do here in that case.
    } catch (err) {
      console.error("Hypha: failed to start checkout", err);
      setCheckoutStatus("error");
    }
  };

  const handleToggle = async (key, value) => {
    onProfileChange((p) => (p ? { ...p, [key]: value } : p)); // optimistic
    setToggleSaving(key);
    try {
      await updateFeatureToggles({ [key]: value });
    } catch (err) {
      onProfileChange((p) => (p ? { ...p, [key]: !value } : p)); // revert on failure
    } finally {
      setToggleSaving(null);
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("sending");
    try {
      await sendMagicLink(email.trim());
      setStatus("sent");
    } catch (err) {
      console.error("Hypha: failed to send magic link", err);
      setStatus("error");
    }
  };

  if (user) {
    return (
      <>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          aria-label="Account settings"
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
        >
          <Avatar email={user.email} />
        </button>

        {modalOpen && (
          <Modal onClose={() => setModalOpen(false)}>
            <div className="p-5 flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar email={user.email} />
                  <div className="min-w-0">
                    <div className="rh-body text-sm font-medium truncate" style={{ color: "#F1E6D3" }}>
                      {user.email}
                    </div>
                    <button
                      type="button"
                      onClick={() => signOut()}
                      className="rh-mono rh-text-10 underline"
                      style={{ color: "#A89478" }}
                    >
                      Sign out
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  aria-label="Close"
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#A89478" }}
                >
                  <X size={18} />
                </button>
              </div>

              <div
                className="rounded-xl p-4 flex items-center justify-between gap-3"
                style={{ backgroundColor: "#14100C", border: "1px solid #3A2E20" }}
              >
                <div className="min-w-0">
                  <span className="rh-mono rh-text-10 uppercase tracking-wider block" style={{ color: "#A89478" }}>
                    Balance
                  </span>
                  <span className="rh-display text-2xl font-semibold" style={{ color: "#E3A73C" }}>
                    {profile == null ? "…" : `$${profile.balanceUsd.toFixed(2)}`}
                  </span>
                </div>

                <form onSubmit={handleAddFunds} className="flex items-center gap-1.5 shrink-0">
                  <div className="relative">
                    <span
                      className="rh-body text-sm absolute pointer-events-none"
                      style={{ color: "#A89478", left: "10px", top: "50%", transform: "translateY(-50%)" }}
                    >
                      $
                    </span>
                    <input
                      type="number"
                      min={MIN_TOPUP_USD}
                      step="1"
                      value={topUpAmount}
                      onChange={(e) => setTopUpAmount(e.target.value)}
                      aria-label="Amount to add"
                      className="rh-body text-sm rounded-full pr-1 py-1.5 border outline-none"
                      style={{ backgroundColor: "#332617", borderColor: "#5A4630", color: "#F1E6D3", width: "68px", paddingLeft: "20px" }}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={checkoutStatus === "starting"}
                    className="rh-body text-sm font-medium rounded-full px-3.5 py-1.5 disabled:opacity-50 shrink-0"
                    style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
                  >
                    {checkoutStatus === "starting" ? "…" : "Add"}
                  </button>
                </form>
              </div>
              {checkoutStatus === "error" && (
                <span className="rh-mono rh-text-10" style={{ color: "#D98A6E" }}>
                  Couldn't start checkout — try again.
                </span>
              )}
              {checkoutStatus === "success" && (
                <span className="rh-mono rh-text-10" style={{ color: "#7FA87A" }}>
                  Funds added!
                </span>
              )}

              <ThrottleGauge profile={profile} />

              <div className="flex flex-col gap-3 pt-3" style={{ borderTop: "1px solid #3A2E20" }}>
                <span className="rh-mono rh-text-10 uppercase tracking-wider" style={{ color: "#A89478" }}>
                  Features (à la carte)
                </span>
                {TOGGLES.map(({ key, label, placeholder }) => (
                  <div key={key} className="flex items-center justify-between">
                    <span className="rh-body text-sm flex items-center gap-1.5" style={{ color: "#F1E6D3" }}>
                      {label}
                      {placeholder && (
                        <span
                          className="rh-mono rh-text-10 uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                          style={{ color: "#A89478", backgroundColor: "#332617" }}
                        >
                          Soon
                        </span>
                      )}
                    </span>
                    <Toggle
                      checked={!!profile?.[key]}
                      disabled={!profile || toggleSaving === key}
                      onChange={(v) => handleToggle(key, v)}
                    />
                  </div>
                ))}
                <span className="rh-mono rh-text-10" style={{ color: "#6B5B45" }}>
                  Dig In is always on. Off features stop drawing on your balance. Email digest is coming soon —
                  toggling it now just saves your preference for launch.
                </span>
              </div>
            </div>
          </Modal>
        )}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        aria-label="Sign in"
        className="flex items-center justify-center rounded-full"
        style={{
          width: "32px",
          height: "32px",
          border: "1px solid #5A4630",
          background: "none",
          cursor: "pointer",
          color: "#A89478",
        }}
      >
        <UserIcon size={16} />
      </button>

      {modalOpen && (
        <Modal onClose={() => setModalOpen(false)}>
          <div className="p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="rh-body text-sm font-medium" style={{ color: "#F1E6D3" }}>
                Sign in
              </span>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Close"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#A89478" }}
              >
                <X size={18} />
              </button>
            </div>

            {status === "sent" ? (
              <span className="rh-body text-sm" style={{ color: "#A89478" }}>
                Check your email for a sign-in link.
              </span>
            ) : (
              <form onSubmit={handleSend} className="flex flex-col gap-2">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  required
                  className="rh-body text-sm rounded-full px-3 py-2 border outline-none"
                  style={{ backgroundColor: "#332617", borderColor: "#5A4630", color: "#F1E6D3" }}
                />
                <button
                  type="submit"
                  disabled={status === "sending"}
                  className="rh-body text-sm font-medium rounded-full px-4 py-2 disabled:opacity-50"
                  style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
                >
                  {status === "sending" ? "Sending…" : "Send link"}
                </button>
                {status === "error" && (
                  <span className="rh-mono rh-text-10" style={{ color: "#D98A6E" }}>
                    Failed — try again.
                  </span>
                )}
              </form>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
