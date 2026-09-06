import { useEffect } from "react";
import { ArrowUpRight } from "lucide-react";

// First-time-only greeting — shown once per browser (see lib/welcome.js),
// purely a hello, not a signup funnel: "Let's go" just dismisses this and
// drops the person straight onto the hero page, same as if they'd closed
// it any other way. Never opens the account modal.
export default function WelcomeModal({ onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10, 8, 5, 0.7)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-2xl border text-center p-7"
        style={{ maxWidth: "420px", borderColor: "#3A2E20", backgroundColor: "#1F1811" }}
      >
        <img src="/hyfax-logo.png" alt="Hyfax" className="h-10 w-auto mx-auto mb-5" />
        <p className="rh-body text-sm leading-relaxed mb-6" style={{ color: "#C9B896" }}>
          <span className="font-semibold" style={{ color: "#E3A73C" }}>
            Well, well, well. Look who it is.
          </span>{" "}
          We have been waiting patiently and want to be the first to welcome you down the rabbit hole of entertaining
          knowledge. So buckle up and enjoy the ride.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rh-body text-sm font-medium rounded-full px-6 py-2.5 inline-flex items-center gap-1.5 transition-colors"
          style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
        >
          Let's go <ArrowUpRight size={15} />
        </button>
      </div>
    </div>
  );
}
