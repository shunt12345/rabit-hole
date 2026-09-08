import { useCallback, useEffect, useMemo, useState } from "react";
import { X, User as UserIcon } from "lucide-react";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { sendMagicLink, signOut } from "./lib/auth.js";
import { updateFeatureToggles } from "./lib/profile.js";
import { fetchCheckoutClientSecret, stripePromise, MIN_TOPUP_USD } from "./lib/billing.js";

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
// "Email digest" (punch list Section E) is live — turning it off actually
// stops the daily digest cron (send-daily-digest) from emailing this
// account, not just a saved preference for later. Defaults on (migration
// 0013). App.jsx doesn't gate anything on it since it's a server-side
// send, not client-rendered content.
const TOGGLES = [
  { key: "featureNews", label: "Trending" },
  { key: "featureToday", label: "Today" },
  { key: "featureDigDeeper", label: "Dig Deeper" },
  { key: "featureEmail", label: "Email digest" },
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

function LegalLinks({ onOpenLegal }) {
  return (
    <div className="flex items-center justify-center gap-3 rh-mono rh-text-10" style={{ color: "#5A4A38" }}>
      <button
        type="button"
        onClick={() => onOpenLegal("terms")}
        className="rh-link-accent transition-colors"
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit" }}
      >
        Terms
      </button>
      <span>·</span>
      <button
        type="button"
        onClick={() => onOpenLegal("privacy")}
        className="rh-link-accent transition-colors"
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit" }}
      >
        Privacy
      </button>
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

export default function AccountMenu({
  user,
  profile,
  onProfileChange,
  onProfileRefresh,
  onLifetimeFundedRefresh,
  onOpenLegal,
  openSignal,
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [modalOpen, setModalOpen] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState(String(MIN_TOPUP_USD));
  const [checkoutStatus, setCheckoutStatus] = useState("idle"); // idle | error | success
  // The embedded checkout panel replaces the rest of the modal's content
  // while open (see the `checkoutOpen ? ... : ...` branch below) — set the
  // instant "Add" is submitted, holding the exact amount that panel should
  // charge (topUpAmount can keep changing underneath it once it's open).
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutAmount, setCheckoutAmount] = useState(null);
  const [toggleSaving, setToggleSaving] = useState(null); // which toggle key is mid-save, if any

  // Stable across re-renders so EmbeddedCheckoutProvider doesn't tear down
  // and remount Checkout (losing whatever the shopper already typed into
  // Stripe's card fields) just because a parent re-render made a new
  // closure — only actually changes if the charged amount itself changes.
  const fetchClientSecret = useCallback(() => fetchCheckoutClientSecret(checkoutAmount), [checkoutAmount]);
  const handleCheckoutComplete = useCallback(() => {
    // Fires for a plain card payment (no redirect needed) — the rare
    // redirect-based-method path instead lands back via the `?checkout=
    // success` return_url handled in the effect below, which does the same
    // wait-then-refresh. Balance crediting itself is 100% webhook-driven
    // (see stripe-webhook) — this delay just gives that async webhook a
    // moment to land before re-reading the profile, same assumption the
    // pre-embedded flow already made.
    setCheckoutOpen(false);
    setCheckoutStatus("success");
    setTimeout(() => {
      onProfileRefresh();
      onLifetimeFundedRefresh();
    }, 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const checkoutOptions = useMemo(
    () => ({ fetchClientSecret, onComplete: handleCheckoutComplete }),
    [fetchClientSecret, handleCheckoutComplete]
  );

  // House ads (Section H) want their CTA to open this same account/funds
  // modal — App.jsx has no direct handle on this component's local
  // modalOpen state, so it just bumps a counter prop; any change opens
  // the modal, same one-way-trigger shape as the checkout-redirect effect
  // below (that one triggers off a URL param instead of a prop).
  useEffect(() => {
    if (openSignal) setModalOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  // Closes this modal before opening the Terms/Privacy one — App.jsx owns
  // that modal separately (see LegalModal.jsx), and stacking two full-
  // screen backdrops on top of each other looks broken rather than
  // layered.
  const openLegal = (doc) => {
    setModalOpen(false);
    onOpenLegal(doc);
  };

  // Embedded checkout resolves a plain card payment inline (see
  // handleCheckoutComplete above) without ever touching this URL — this
  // effect only matters for the rare case where a redirect-based payment
  // method was used, which Stripe sends back to `/?checkout=success` (see
  // create-checkout-session's return_url) since redirect_on_completion is
  // "if_required". Same wait-then-refresh reasoning either way: the webhook
  // that actually credits the balance runs asynchronously on Stripe's side.
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

  const handleAddFunds = (e) => {
    e.preventDefault();
    const amount = Number(topUpAmount);
    if (!Number.isFinite(amount) || amount < MIN_TOPUP_USD) return;
    setCheckoutStatus("idle");
    setCheckoutAmount(amount);
    setCheckoutOpen(true);
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
      console.error("Hyfax: failed to send magic link", err);
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
          <Modal
            onClose={() => {
              setModalOpen(false);
              setCheckoutOpen(false);
            }}
          >
            {checkoutOpen ? (
              <div className="p-5 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="rh-body text-sm font-medium" style={{ color: "#F1E6D3" }}>
                    Add ${checkoutAmount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCheckoutOpen(false)}
                    aria-label="Cancel"
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#A89478" }}
                  >
                    <X size={18} />
                  </button>
                </div>
                {/* Fixed min-height so the modal doesn't jump around as
                    Stripe's iframe loads its own content in — Checkout
                    resizes itself within this box once it's ready. */}
                <div style={{ minHeight: "420px" }}>
                  <EmbeddedCheckoutProvider stripe={stripePromise} options={checkoutOptions}>
                    <EmbeddedCheckout />
                  </EmbeddedCheckoutProvider>
                </div>
              </div>
            ) : (
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

                {/* Shown for a signed-in, never-funded account — this is the
                  moment "account created" is actually true, and where the
                  next step (funding) is right below. Clears up the same
                  point of confusion the pre-signup form used to try to
                  cover (someone arriving via a house ad's "Let's go" CTA
                  could easily assume signing in is the whole unlock — it
                  isn't). Disappears on its own once balanceUsd > 0. */}
              {profile && profile.balanceUsd === 0 && (
                <p className="rh-body text-sm" style={{ color: "#A89478" }}>
                  Your account has been created! Fund your account to start drinking from the firehose of knowledge!
                </p>
              )}

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
                      className="rh-body rh-no-spinner text-sm rounded-full pr-1 py-1.5 border outline-none"
                      style={{ backgroundColor: "#332617", borderColor: "#5A4630", color: "#F1E6D3", width: "68px", paddingLeft: "20px" }}
                    />
                  </div>
                  <button
                    type="submit"
                    className="rh-body text-sm font-medium rounded-full px-3.5 py-1.5 disabled:opacity-50 shrink-0"
                    style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
                  >
                    Add
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
                  Dig In is always on. Off features stop drawing on your balance.
                </span>
              </div>

              <div className="pt-3" style={{ borderTop: "1px solid #3A2E20" }}>
                <LegalLinks onOpenLegal={openLegal} />
              </div>
              </div>
            )}
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

            <div className="pt-2 mt-1" style={{ borderTop: "1px solid #3A2E20" }}>
              <LegalLinks onOpenLegal={openLegal} />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
