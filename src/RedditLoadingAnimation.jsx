import { useEffect } from "react";

// Reddit-ad landing animation — shown while the (usually cache-hit, near-
// instant) root request for the ad's prefilled question is in flight. Pure
// CSS/SVG, no video file: a mushroom cap rising up from a ground line with
// gold mycelium threads spreading out underneath it, echoing the branching-
// threads mechanic the ad itself shows (chips fanning out from one topic).
// Disappears the INSTANT the real request resolves (see App.jsx — this is
// rendered only while rootLoading is true), never holding chips back to
// let its own animation cycle finish; the "2-3s" in the brief describes how
// long one loop of this animation takes to play, not a minimum display
// time. Always skippable via the button — a visitor who's seen enough
// shouldn't need to wait even that long.
export default function RedditLoadingAnimation({ onSkip }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center"
      style={{ backgroundColor: "#14100C" }}
      role="status"
      aria-live="polite"
      aria-label="Loading your thread"
    >
      <svg width="220" height="220" viewBox="0 0 220 220" style={{ overflow: "visible" }}>
        {/* Ground line */}
        <line x1="20" y1="165" x2="200" y2="165" stroke="#3A2E20" strokeWidth="2" />

        {/* Mycelium threads — spread out from the base, each on its own
            staggered delay so they read as growing outward rather than
            popping in together. stroke-dasharray/dashoffset animated to
            "draw" the line, matching the branching visual of the app
            itself (chips spreading from a root topic). */}
        <g stroke="#E3A73C" strokeWidth="1.5" fill="none" opacity="0.85">
          {[
            "M110,165 Q70,175 40,185",
            "M110,165 Q90,180 75,200",
            "M110,165 Q110,185 110,205",
            "M110,165 Q130,180 145,200",
            "M110,165 Q150,175 180,185",
            "M110,165 Q60,170 30,168",
            "M110,165 Q160,170 190,168",
          ].map((d, i) => (
            <path
              key={i}
              d={d}
              pathLength="1"
              style={{
                strokeDasharray: 1,
                strokeDashoffset: 1,
                animation: `rh-mycelium-grow 1.1s ease-out forwards`,
                animationDelay: `${0.15 + i * 0.09}s`,
              }}
            />
          ))}
        </g>

        {/* Mushroom, rising from the ground line */}
        <g style={{ animation: "rh-mushroom-rise 0.9s cubic-bezier(0.16, 1, 0.3, 1) forwards", transformOrigin: "110px 165px" }}>
          <rect x="104" y="120" width="12" height="45" rx="4" fill="#F1E6D3" />
          <path d="M70,120 Q110,60 150,120 Q135,132 110,132 Q85,132 70,120 Z" fill="#E3A73C" />
          <ellipse cx="92" cy="105" rx="5" ry="3.5" fill="#F1E6D3" opacity="0.7" />
          <ellipse cx="118" cy="98" rx="4" ry="3" fill="#F1E6D3" opacity="0.6" />
          <ellipse cx="132" cy="112" rx="3.5" ry="2.5" fill="#F1E6D3" opacity="0.6" />
        </g>
      </svg>

      <p className="rh-body text-sm mt-6" style={{ color: "#A89478" }}>
        Digging in…
      </p>

      <button
        type="button"
        onClick={onSkip}
        className="rh-body text-xs mt-8 underline"
        style={{ color: "#6B5B45" }}
      >
        Skip
      </button>

      <style>{`
        @keyframes rh-mushroom-rise {
          from { transform: translateY(24px) scale(0.7); opacity: 0; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
        @keyframes rh-mycelium-grow {
          to { stroke-dashoffset: 0; }
        }
      `}</style>
    </div>
  );
}
