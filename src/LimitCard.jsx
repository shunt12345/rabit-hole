// The free-limit offer, shown in place of more threads once today's free
// pages are used up: a visitor without an account is offered a free one
// (more pages a day), an account at its limit is offered funds. Styled like
// the house ads (AdCard) so it reads as an offer, not as more article text.
// onHero: the hero page's version (a topic page's version also promises to
// bring them back to that page after signing up).
import { ArrowUpRight } from "lucide-react";

// What a free account gets per day. Mirrors the proxy's SIGNED_IN_SEARCH_LIMIT
// default; the proxy's own response headers stay the source of truth once a
// call comes back.
export const SIGNED_IN_PAGE_LIMIT = 10;

export default function LimitCard({ signedIn, pageLimit, onHero, onAction }) {
  return (
    <div className="rounded-2xl p-4 flex gap-3 items-start text-left" style={{ backgroundColor: "#6E4A2C" }}>
      <div
        className="shrink-0 flex items-center justify-center rounded-xl"
        style={{ width: "44px", height: "44px", backgroundColor: "#14100C" }}
      >
        <img src="/hyfax-logo.png" alt="" className="w-7 h-auto" />
      </div>
      <div className="rh-display">
        <div className="text-base mb-1" style={{ color: "#E3A73C", fontWeight: 700 }}>
          {signedIn ? "You've read today's free pages" : "Sign up free to keep going"}
        </div>
        <p className="text-sm leading-relaxed mb-3" style={{ color: "#FFFFFF" }}>
          {signedIn
            ? `Your ${pageLimit} free pages reset at 3am your time. Add funds for full access now.`
            : `You've read today's ${pageLimit} free pages. Sign up free for ${SIGNED_IN_PAGE_LIMIT} more today${
                onHero ? "." : ", and we'll bring you right back to this page."
              }`}
        </p>
        <button
          type="button"
          onClick={onAction}
          className="inline-flex items-center gap-1 text-sm font-semibold rounded-full px-4 py-2"
          style={{ backgroundColor: "#E3A73C", color: "#14100C" }}
        >
          {signedIn ? "Add funds" : "Sign up free"}
          <ArrowUpRight size={14} />
        </button>
      </div>
    </div>
  );
}
