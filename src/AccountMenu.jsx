import { useEffect, useState } from "react";
import { sendMagicLink, signOut } from "./lib/auth.js";
import { updateFeatureToggles, getLifetimeFundedUsd } from "./lib/profile.js";
import { startCheckout, MIN_TOPUP_USD } from "./lib/billing.js";

// Production punch list, Section C (funded experience): balance, the
// "Usage" gas-gauge, and the per-feature toggle panel, layered on top of
// Section D's bare sign-in/balance/add-funds bar. Node count ("Explore —
// 3/4/5 nodes") is deliberately NOT a toggle here — its exact mechanics
// are still an open decision (punch list Section G), so it isn't built
// until that's actually decided. The always-visible bar stays compact
// (email, balance, sign out); everything else lives behind "Manage".
//
// `profile`/`onProfileChange`/`onProfileRefresh` are owned by App.jsx, not
// this component — App.jsx is what actually gates News/Today/Dig Deeper on
// these same toggle values, so it needs the single source of truth, not a
// second copy that could drift out of sync with what's rendered there.
const TOGGLES = [
  { key: "featureNews", label: "News" },
  { key: "featureToday", label: "Today" },
  { key: "featureDigDeeper", label: "Dig Deeper" },
];

export default function AccountMenu({ user, profile, onProfileChange, onProfileRefresh }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [lifetimeFunded, setLifetimeFunded] = useState(null);
  const [topUpAmount, setTopUpAmount] = useState(String(MIN_TOPUP_USD));
  const [checkoutStatus, setCheckoutStatus] = useState("idle"); // idle | starting | error | success
  const [toggleSaving, setToggleSaving] = useState(null); // which toggle key is mid-save, if any

  useEffect(() => {
    if (!user) {
      setLifetimeFunded(null);
      return;
    }
    getLifetimeFundedUsd().then(setLifetimeFunded);
  }, [user]);

  // Stripe redirects back to `/?checkout=success` (or `?checkout=cancel`)
  // after a top-up — see create-checkout-session's success_url/cancel_url.
  // The webhook that actually credits the balance runs asynchronously on
  // Stripe's side, so this waits a moment before re-reading it rather than
  // assuming it's already landed the instant the browser redirects back.
  // Only runs once on mount; the query param is stripped either way so a
  // page refresh doesn't keep re-showing the message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (!checkout) return;
    window.history.replaceState({}, "", window.location.pathname);
    if (checkout === "success") {
      setCheckoutStatus("success");
      setManageOpen(true);
      const timeoutId = setTimeout(() => {
        onProfileRefresh();
        getLifetimeFundedUsd().then(setLifetimeFunded);
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
    // Real usage gauge (punch list Section C): fraction of every dollar
    // ever funded that's already been spent — a real, non-fabricated
    // number rather than an arbitrary made-up ceiling. Undefined (never
    // funded, nothing to show a gauge against) until the first top-up
    // lands.
    const usageFraction =
      lifetimeFunded && lifetimeFunded > 0 && profile
        ? Math.min(1, Math.max(0, 1 - profile.balanceUsd / lifetimeFunded))
        : null;

    return (
      <div className="rh-mono rh-text-10" style={{ color: "#A89478" }}>
        <div className="flex items-center gap-2">
          <span>{user.email}</span>
          <span style={{ color: "#E3A73C" }}>
            {profile == null ? "…" : `$${profile.balanceUsd.toFixed(2)}`}
          </span>
          <button
            type="button"
            onClick={() => setManageOpen((v) => !v)}
            className="underline"
            style={{ color: "#A89478" }}
          >
            {manageOpen ? "Hide" : "Manage"}
          </button>
          <button type="button" onClick={() => signOut()} className="underline" style={{ color: "#A89478" }}>
            Sign out
          </button>
        </div>

        {manageOpen && (
          <div
            className="mt-2 p-3 rounded-xl border flex flex-col gap-3"
            style={{ borderColor: "#3A2E20", backgroundColor: "#1F1811", width: "220px" }}
          >
            {usageFraction != null && (
              <div>
                <div className="flex justify-between mb-1">
                  <span>Usage</span>
                  <span>{Math.round(usageFraction * 100)}%</span>
                </div>
                <div className="rounded-full overflow-hidden" style={{ height: "4px", backgroundColor: "#3A2E20" }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${usageFraction * 100}%`, backgroundColor: "#E3A73C" }}
                  />
                </div>
              </div>
            )}

            <form onSubmit={handleAddFunds} className="flex items-center gap-1">
              <span>$</span>
              <input
                type="number"
                min={MIN_TOPUP_USD}
                step="1"
                value={topUpAmount}
                onChange={(e) => setTopUpAmount(e.target.value)}
                className="rh-body text-xs rounded-full px-2 py-0.5 border outline-none"
                style={{ backgroundColor: "#332617", borderColor: "#5A4630", color: "#F1E6D3", width: "56px" }}
              />
              <button
                type="submit"
                disabled={checkoutStatus === "starting"}
                className="underline disabled:opacity-50"
                style={{ color: "#E3A73C" }}
              >
                {checkoutStatus === "starting" ? "Redirecting…" : "Add funds"}
              </button>
            </form>
            {checkoutStatus === "error" && (
              <span style={{ color: "#D98A6E" }}>Couldn't start checkout — try again.</span>
            )}
            {checkoutStatus === "success" && <span style={{ color: "#7FA87A" }}>Funds added!</span>}

            <div className="flex flex-col gap-1">
              <span style={{ color: "#C9B896" }}>Features (à la carte)</span>
              {TOGGLES.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!profile?.[key]}
                    disabled={!profile || toggleSaving === key}
                    onChange={(e) => handleToggle(key, e.target.checked)}
                  />
                  <span>{label}</span>
                </label>
              ))}
              <span className="mt-0.5" style={{ color: "#6B5B45" }}>
                Dig In is always on. Off features stop drawing on your balance.
              </span>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rh-mono rh-text-10 underline"
        style={{ color: "#A89478" }}
      >
        Sign in
      </button>
    );
  }

  if (status === "sent") {
    return (
      <span className="rh-mono rh-text-10" style={{ color: "#A89478" }}>
        Check your email for a sign-in link.
      </span>
    );
  }

  return (
    <form onSubmit={handleSend} className="flex items-center gap-1.5">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@email.com"
        required
        className="rh-body text-xs rounded-full px-3 py-1 border outline-none"
        style={{ backgroundColor: "#332617", borderColor: "#5A4630", color: "#F1E6D3", width: "140px" }}
      />
      <button
        type="submit"
        disabled={status === "sending"}
        className="rh-mono rh-text-10 underline disabled:opacity-50"
        style={{ color: "#E3A73C" }}
      >
        {status === "sending" ? "Sending…" : "Send link"}
      </button>
      {status === "error" && (
        <span className="rh-mono" style={{ color: "#D98A6E", fontSize: 10 }}>
          Failed — try again.
        </span>
      )}
    </form>
  );
}
