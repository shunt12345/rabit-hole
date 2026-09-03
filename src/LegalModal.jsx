import { useEffect } from "react";
import { X } from "lucide-react";
import { TERMS_SECTIONS, PRIVACY_SECTIONS, LEGAL_LAST_UPDATED } from "./legalContent.js";

// Same backdrop/Escape-to-close pattern as AccountMenu's Modal — kept as
// its own copy rather than a shared import since AccountMenu's version
// isn't exported and this is the only other place a modal is needed.
export default function LegalModal({ doc, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sections = doc === "terms" ? TERMS_SECTIONS : PRIVACY_SECTIONS;
  const title = doc === "terms" ? "Terms of Service" : "Privacy Policy";

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
        style={{ maxWidth: "560px", maxHeight: "80vh", borderColor: "#3A2E20", backgroundColor: "#1F1811", display: "flex", flexDirection: "column" }}
      >
        <div className="flex items-center justify-between p-5 border-b shrink-0" style={{ borderColor: "#3A2E20" }}>
          <div>
            <h2 className="rh-display text-xl italic" style={{ color: "#F1E6D3" }}>
              {title}
            </h2>
            <div className="rh-mono rh-text-10" style={{ color: "#6B5B45" }}>
              Last updated {LEGAL_LAST_UPDATED}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: "none", border: "none", cursor: "pointer", color: "#A89478" }}
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-5 overflow-y-auto rh-body text-sm" style={{ color: "#C9B896" }}>
          {sections.map((s) => (
            <div key={s.heading} className="mb-5 last:mb-0">
              <h3 className="font-semibold mb-1.5" style={{ color: "#F1E6D3" }}>
                {s.heading}
              </h3>
              <p style={{ lineHeight: 1.6 }}>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
