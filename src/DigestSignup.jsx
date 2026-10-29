import { useState } from "react";
import { Mail, Loader2 } from "lucide-react";
import { subscribeToDigest, hasDigestSignup } from "./lib/digest.js";
import { reportTikTokSubscribe } from "./lib/tiktokPixel.js";

// "Get the daily threads by email" — the email-only way into the daily
// digest, for people who don't want an account (see lib/digest.js). Shown
// to signed-out visitors only (an account has its own digest toggle), and
// not again in a browser that already signed up.
// source: where it sits ("home" | "article"), recorded for /admin.
export default function DigestSignup({ source }) {
  const [hidden] = useState(() => hasDigestSignup());
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent
  const [error, setError] = useState(null);

  if (hidden) return null;

  const submit = async (e) => {
    e.preventDefault();
    if (state === "sending") return;
    setError(null);
    setState("sending");
    try {
      await subscribeToDigest(email.trim(), source);
      reportTikTokSubscribe(email.trim());
      setState("sent");
    } catch (err) {
      setError(err.message);
      setState("idle");
    }
  };

  return (
    <div className="max-w-md mx-auto p-5 rounded-2xl border text-left" style={{ borderColor: "#4A3826", backgroundColor: "#241B12" }}>
      <div className="flex items-center gap-1.5 rh-mono text-xs uppercase tracking-wider font-semibold" style={{ color: "#E3A73C" }}>
        <Mail size={13} /> The daily threads
      </div>
      {state === "sent" ? (
        <p className="rh-body text-sm mt-2" style={{ color: "#F1E6D3" }}>
          Almost there. Check your inbox and tap the link to confirm.
        </p>
      ) : (
        <>
          <p className="rh-body text-sm mt-1" style={{ color: "#B8A886" }}>
            A quote, a moment in history, a word, a riddle and what's trending, in your inbox every morning. No account needed.
          </p>
          <form onSubmit={submit} className="flex items-center gap-2 mt-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              aria-label="Your email"
              className="rh-body flex-1 min-w-0 border outline-none rh-placeholder rh-input text-sm rounded-full px-4 py-2.5 transition-colors"
              style={{ backgroundColor: "#332617", borderColor: "#5A4630", color: "#F1E6D3" }}
            />
            <button
              type="submit"
              disabled={state === "sending"}
              className="rh-body flex items-center gap-1.5 text-sm font-semibold rounded-full px-4 py-2.5 shrink-0 rh-btn-accent disabled:opacity-60"
              style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
            >
              {state === "sending" ? <Loader2 size={15} className="animate-spin" /> : "Sign up"}
            </button>
          </form>
          {error && (
            <p className="rh-body text-xs mt-2" style={{ color: "#D98A6E" }}>
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
