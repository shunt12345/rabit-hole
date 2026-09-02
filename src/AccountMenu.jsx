import { useState } from "react";
import { sendMagicLink, signOut } from "./lib/auth.js";

// Deliberately minimal for this first pass — just enough to prove accounts
// exist end to end (send a magic link, land back signed in, sign out).
// The funded-experience UI (balance, feature toggles, usage meters) is a
// separate, later build — see the production punch list, Section C. This
// only needs to answer "is anyone signed in," not do anything with it yet.
export default function AccountMenu({ user }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [open, setOpen] = useState(false);

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
