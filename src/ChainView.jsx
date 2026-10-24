import { Fragment, useEffect, useRef, useState } from "react";
import ThreadTitle from "./ThreadTitle.jsx";
import { ChevronRight, Shuffle, ArrowRight, ChevronDown, Share2, Check } from "lucide-react";
import { splitThreadTitle } from "./lib/chains.js";

// A Hyfax chain (lib/chains.js): four topics on one thread, each an indirect
// leap from the one before. Every step opens in place for a deeper
// explanation, and can be dug into as its own Hyfax page. Pre-written, so
// opening a chain counts as one page (showChain in App.jsx); digging into a step counts like any
// other page.
// The leap's kind, as on the Where cards: an indirect leap shares a
// mechanism, a tangent side-steps through a looser real link. Chains
// written before kinds existed show as indirect.
const KINDS = {
  indirect: { label: "Indirect", color: "#9DB38E" },
  tangent: { label: "Tangent", color: "#C48BB3" },
};

// The thread unfolds as the reader scrolls: step 1 shows, and each scroll
// down past the "keep scrolling" line reveals the next step, so the leaps
// are discovered one at a time rather than given away. Tapping the line
// reveals it too.
// On a wide screen the steps zigzag (left, right, left, right), each a
// little over half the width, joined by a curved line carrying the leap's
// label, so the thread fills the screen. Phones keep the single column.
const SIDE_WIDTH = "md:w-[56%]";
function sideClass(i) {
  return `${SIDE_WIDTH} ${i % 2 ? "md:ml-auto" : ""}`;
}
// The curve from step i-1's side to step i's (centres at 28% and 72%).
function WideConnector({ toRight, label, dashed = false }) {
  const [a, b] = toRight ? [28, 72] : [72, 28];
  return (
    <div className="hidden md:block relative h-16" aria-hidden="true">
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 64" preserveAspectRatio="none">
        <path
          d={`M${a} 0 C${a} 34, ${b} 30, ${b} 64`}
          fill="none"
          stroke={dashed ? "rgba(227,167,60,0.45)" : "rgba(227,167,60,0.6)"}
          strokeWidth="2"
          strokeDasharray={dashed ? "6 6" : undefined}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {!dashed && (
        <span
          className="absolute -bottom-1 w-2.5 h-2.5 rounded-full -translate-x-1/2"
          style={{ left: `${b}%`, backgroundColor: "#E3A73C", boxShadow: "0 0 10px rgba(227,167,60,0.8)" }}
        />
      )}
      {label && (
        <span
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rh-mono rh-text-10 uppercase tracking-wider px-2 whitespace-nowrap"
          style={{ color: "#8A7A62", backgroundColor: "#14100C" }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

const REVEAL_LINE = 0.5; // how far up the screen the hint has to rise (0 = top)
const REVEAL_GAP_MS = 600; // at most one step per this, however fast the scroll

export default function ChainView({ chain, onDigIn, onSpinAgain, onStepOpened, onStepRevealed, onShared }) {
  const [open, setOpen] = useState({});
  // Share: a link that opens this thread (/t/<id>), through the phone's
  // share sheet, or copied where there isn't one. Only the A-to-B title
  // goes with it; the steps stay a surprise.
  const [shared, setShared] = useState(null); // null | "copied" | "error"
  const share = async () => {
    // /t/<id> (api/thread.js) gives the link its own preview card, then
    // opens the thread in the app.
    const url = `${window.location.origin}/t/${chain.id}`;
    const { from, to } = splitThreadTitle(chain.title);
    const title = to ? `From ${from} to ${to}` : chain.title;
    onShared?.();
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
      } else {
        await navigator.clipboard.writeText(url);
        setShared("copied");
        setTimeout(() => setShared(null), 2000);
      }
    } catch (e) {
      if (e?.name === "AbortError") return; // share sheet dismissed
      setShared("error");
      setTimeout(() => setShared(null), 2000);
    }
  };
  const [revealed, setRevealed] = useState(1);
  const hintRef = useRef(null);
  const lastRevealRef = useRef(0);
  const total = chain.steps.length;
  const reveal = () => {
    if (revealed >= total) return;
    lastRevealRef.current = Date.now();
    onStepRevealed?.(revealed);
    // The step just passed opens its deeper explanation as the next one
    // appears (not tracked as a tap: the reader didn't choose it).
    setOpen((prev) => ({ ...prev, [revealed - 1]: true }));
    setRevealed(revealed + 1);
  };
  // A scroll down marks the next step as wanted; it appears once the hint
  // has risen past REVEAL_LINE and the last reveal is REVEAL_GAP_MS old,
  // checked again after the gap so a scroll that hit the bottom of the
  // page during it still counts.
  const wantedRef = useRef(false);
  useEffect(() => {
    const scroller = hintRef.current?.closest(".overflow-y-auto") || window;
    let lastTop = scroller === window ? window.scrollY : scroller.scrollTop;
    let timer = null;
    const check = () => {
      if (!wantedRef.current || !hintRef.current) return;
      const wait = REVEAL_GAP_MS - (Date.now() - lastRevealRef.current);
      if (wait > 0) {
        clearTimeout(timer);
        timer = setTimeout(check, wait);
        return;
      }
      if (hintRef.current.getBoundingClientRect().top < window.innerHeight * REVEAL_LINE) {
        wantedRef.current = false;
        reveal();
      }
    };
    const onScroll = () => {
      const top = scroller === window ? window.scrollY : scroller.scrollTop;
      if (top > lastTop) wantedRef.current = true;
      lastTop = top;
      check();
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      scroller.removeEventListener("scroll", onScroll);
    };
  });
  const toggle = (i) => {
    const opening = !open[i];
    setOpen((prev) => ({ ...prev, [i]: opening }));
    if (opening) onStepOpened?.(i);
  };

  return (
    <div className="max-w-md md:max-w-4xl w-full mx-auto rh-fade-in">
      <div className="flex justify-end mb-2">
        <button
          type="button"
          onClick={share}
          aria-label="Share"
          className="flex items-center gap-1.5 rh-mono rh-text-10 uppercase tracking-wider rounded-full border font-semibold px-3 py-1.5 transition-colors"
          style={{
            borderColor: shared === "error" ? "#D98A6E" : "#E3A73C",
            color: shared === "error" ? "#D98A6E" : "#E3A73C",
            backgroundColor: shared === "copied" ? "#E3A73C22" : "transparent",
          }}
        >
          {shared === "copied" ? (
            <>
              <Check size={13} /> Link copied
            </>
          ) : shared === "error" ? (
            "Couldn't share"
          ) : (
            <>
              <Share2 size={13} /> Share
            </>
          )}
        </button>
      </div>
      <div className="text-center mb-6">
        <div className="rh-mono rh-text-10 uppercase tracking-widest mb-2" style={{ color: "#E3A73C" }}>
          A Hyfax thread
        </div>
        <h2 aria-label={chain.title}>
          <ThreadTitle title={chain.title} size="text-3xl" align="center" />
        </h2>
        <div className="rh-body text-sm mt-3" style={{ color: "#A89478" }}>
          Four steps on one thread
        </div>
      </div>

      {chain.steps.slice(0, revealed).map((step, i) => {
        const isOpen = !!open[i];
        const main = i === 0;
        const kind = KINDS[step.kind] || KINDS.indirect;
        return (
          <Fragment key={i}>
            {i > 0 && <WideConnector toRight={i % 2 === 1} label={step.link} />}
            <div className={`${i > 0 ? "rh-fade-in" : ""} ${sideClass(i)}`}>
            {i > 0 && (
              <div className="relative ml-8 h-9 md:hidden" aria-hidden="true">
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
          </Fragment>
        );
      })}

      {revealed < total ? (
        // Room to scroll into, so the next step can be reached even when
        // the page so far fits on the screen.
        <div ref={hintRef} style={{ minHeight: "75vh" }}>
          <WideConnector toRight={revealed % 2 === 1} dashed />
          <div className="relative ml-8 h-9 md:hidden" aria-hidden="true">
            <span className="absolute left-0 top-0 bottom-0 border-l-2 border-dashed" style={{ borderColor: "rgba(227,167,60,0.45)" }} />
          </div>
          <div className={sideClass(revealed)}>
          <button
            type="button"
            onClick={reveal}
            className="w-full flex items-center justify-center gap-1.5 rounded-2xl border border-dashed py-4 rh-body text-sm"
            style={{ borderColor: "#4A3826", color: "#C9B896" }}
          >
            Keep scrolling to reveal step {revealed + 1} <ChevronDown size={16} className="rh-nudge" />
          </button>
          </div>
        </div>
      ) : (
      <div className="mt-8 pt-5 border-t text-center rh-fade-in" style={{ borderColor: "#3A2E20" }}>
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
      )}
    </div>
  );
}
