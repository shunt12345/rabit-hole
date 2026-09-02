import { useEffect, useState } from "react";
import { sendMagicLink, signOut } from "./lib/auth.js";
import { getBalance } from "./lib/profile.js";
import { startCheckout, MIN_TOPUP_USD } from "./lib/billing.js";

// The feature-toggle panel, usage/speed gauges, and "$" balance shown
// during active reading are still a separate, later build (production
// punch list, Section C) — this only adds the account-page balance readout
// and the "add funds" entry point that Section D's billing needs to be
// usable at all.
export default function AccountMenu({ user }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState(null);
  const [topUpAmount, setTopUpAmount] = useState(String(MIN_TOPUP_USD));
  const [checkoutStatus, setCheckoutStatus] = useState("idle"); // idle | starting | error

  useEffect(() => {
    if (!user) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    getBalance().then((b) => {
      if (!cancelled) setBalance(b);
    });
    return () => {
      cancelled = true;
    };
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
      const timeoutId = setTimeout(() => {
        getBalance().then((b) => setBalance(b));
      }, 1500);
      return () => clearTimeout(timeoutId);
    }
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
      <div className="flex items-center gap-2 rh-mono rh-text-10" style={{ color: "#A89478" }}>
        <span>{user.email}</span>
        <span style={{ color: "#E3A73C" }}>
          {balance == null ? "…" : `$${balance.toFixed(2)}`}
        </span>
        <form onSubmit={handleAddFunds} className="flex items-center gap-1">
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
        <button type="button" onClick={() => signOut()} className="underline" style={{ color: "#A89478" }}>
          Sign out
        </button>
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
