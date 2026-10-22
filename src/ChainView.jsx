import { useState } from "react";
import { ChevronRight, Shuffle, ArrowRight } from "lucide-react";

// A Hyfax chain (lib/chains.js): four topics on one thread, each an indirect
// leap from the one before. Every step opens in place for a deeper
// explanation, and can be dug into as its own Hyfax page. Pre-written, so
// reading a chain costs no searches; digging into a step counts like any
// other page.
// The leap's kind, as on the Where cards: an indirect leap shares a
// mechanism, a tangent side-steps through a looser real link. Chains
// written before kinds existed show as indirect.
const KINDS = {
  indirect: { label: "Indirect", color: "#9DB38E" },
  tangent: { label: "Tangent", color: "#C48BB3" },
};

export default function ChainView({ chain, onDigIn, onSpinAgain, onStepOpened }) {
  const [open, setOpen] = useState({});
  const toggle = (i) => {
    const opening = !open[i];
    setOpen((prev) => ({ ...prev, [i]: opening }));
    if (opening) onStepOpened?.(i);
  };

  return (
    <div className="max-w-md w-full mx-auto rh-fade-in">
      <div className="text-center mb-6">
        <div className="rh-mono rh-text-10 uppercase tracking-widest mb-2" style={{ color: "#E3A73C" }}>
          A Hyfax thread
        </div>
        <h2 className="rh-display text-3xl italic leading-tight" style={{ color: "#F1E6D3" }}>
          {chain.title}
        </h2>
        <div className="rh-body text-sm mt-1" style={{ color: "#A89478" }}>
          Four steps on one thread
        </div>
      </div>

      {chain.steps.map((step, i) => {
        const isOpen = !!open[i];
        const main = i === 0;
        const kind = KINDS[step.kind] || KINDS.indirect;
        return (
          <div key={i}>
            {i > 0 && (
              <div className="relative ml-8 h-9" aria-hidden="true">
                <span className="absolute left-0 top-0 bottom-0 border-l-2" style={{ borderColor: "rgba(227,167,60,0.6)" }} />
                <span className="absolute -left-1 -bottom-0.5 w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "#E3A73C", boxShadow: "0 0 10px rgba(227,167,60,0.8)" }} />
                <span className="absolute left-4 top-2.5 rh-mono rh-text-10 uppercase tracking-wider" style={{ color: "#8A7A62" }}>
                  {step.link}
                </span>
              </div>
            )}
            <div
              className={`rounded-2xl border transition-colors ${isOpen ? "" : "rh-thread-card"}`}
              style={{
                borderColor: main || isOpen ? "#E3A73C" : "#4A3826",
                background: isOpen ? "#2A2015" : main ? "linear-gradient(160deg,#2E2216,#1F1811)" : "#241B12",
              }}
            >
              <button type="button" onClick={() => toggle(i)} aria-expanded={isOpen} className="w-full text-left px-4 py-3.5 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="rh-mono rh-text-10 uppercase tracking-wider font-semibold flex justify-between" style={{ color: main ? "#E3A73C" : kind.color }}>
                    <span>{main ? "Start here" : kind.label}</span>
                    <span style={{ color: "#6B5B45" }}>
                      {i + 1} / {chain.steps.length}
                    </span>
                  </div>
                  <div className={main ? "rh-display text-2xl italic mt-1" : "rh-body text-base font-semibold mt-1"} style={{ color: "#F1E6D3" }}>
                    {step.title}
                  </div>
                  <div className="rh-body text-sm mt-1 leading-snug" style={{ color: "#C9BA9C" }}>
                    {step.why}
                  </div>
                </div>
                <span className="shrink-0 mt-1 flex items-center justify-center rounded-full w-8 h-8" style={{ backgroundColor: "#E3A73C", color: "#14100C" }} aria-hidden="true">
                  <ChevronRight size={18} className="rh-chev" style={{ transform: isOpen ? "rotate(90deg)" : "none" }} />
                </span>
              </button>
              {isOpen && (
                <div className="px-4 pb-4 rh-fade-in">
                  <p className="rh-body text-base leading-relaxed pt-3 border-t" style={{ color: "#F1E6D3", borderColor: "#3A2E20" }}>
                    {step.deep}
                  </p>
                  <button
                    type="button"
                    onClick={() => onDigIn(step, i)}
                    className="mt-3 flex items-center gap-1 rh-body text-sm font-semibold"
                    style={{ color: "#E3A73C" }}
                  >
                    Dig into {step.title} <ArrowRight size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}

      <div className="mt-8 pt-5 border-t text-center" style={{ borderColor: "#3A2E20" }}>
        <p className="rh-body text-sm mb-4" style={{ color: "#A89478" }}>
          Tap any step to go deeper.
        </p>
        <button
          type="button"
          onClick={onSpinAgain}
          className="rh-body inline-flex items-center gap-1.5 text-sm font-medium rounded-full px-5 py-3 transition-colors rh-btn-accent"
          style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
        >
          <Shuffle size={15} /> Spin another thread
        </button>
      </div>
    </div>
  );
}
