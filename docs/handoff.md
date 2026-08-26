# Rabbit Hole — Handoff Brief for Claude Code

## What this is

Rabbit Hole is a curiosity-driven exploration app: drop in a topic, get five AI-generated
branches to explore next (a mix of direct facts, adjacent ideas, and deliberately wild
tangential leaps), read a short AI-generated article per topic, keep branching. Entertainment-
first, not a research tool — voice is deliberately "unhinged" (breathless, energetic, witty),
and every prompt in the code enforces that tone plus a hard no-first-person / no-markdown rule.

It currently runs as a single-file React component inside a claude.ai artifact, authenticated
automatically by that environment. **The task here is taking it independent**, per the two-phase
plan below.

## Current state — what's already built and proven

- `app/rabbit-hole-chips.jsx` — the complete, working React app. Single file, built for the
  claude.ai artifact preview specifically, not yet a standalone deployable project. Uses
  `model: "claude-sonnet-5"` for all generation calls — deliberately chosen over the cheaper
  Haiku 4.5 after a real side-by-side comparison; Sonnet is what actually produces the voice
  this app depends on. Don't downgrade the model as a cost-saving measure without re-running
  that comparison.
- `backend/supabase-trending-topics-function.ts` — a Supabase Edge Function proxying SerpApi's
  Google News endpoint for the "In the news" hero-screen chips. Written and **confirmed working**
  by calling it directly and getting real headline JSON back. Deployed under the function name
  `smooth-responder` (not `trending-topics` — the app's `SUPABASE_URL`/fetch call already points
  at the correct deployed name, don't "fix" it back to `trending-topics`).
- Supabase project: `https://gflcioanuzrxgxxafnzl.supabase.co`. A publishable key is already
  embedded in `rabbit-hole-chips.jsx` (`SUPABASE_ANON_KEY`) — that's intentional and safe, it's
  the client-safe key type, not a secret.
- The app already reads a starting topic from a URL query param (`?topic=...`) on load, intended
  as the landing side of a future bookmarklet/browser-extension "explore this from anywhere"
  feature. Not built yet, just the landing hook.

## The task, in two phases

### Phase 1 — ship with Option A (one shared key)

Get this live on real hosting with a single embedded Anthropic API key that all visitors'
requests flow through. Simplest path to "friends can use this without their own Claude account."

- Turn the single-file app into a real deployable project (Vite/Next, whichever fits the chosen
  host best).
- **Do not put the Anthropic API key in client-side code.** The current
  `fetch("https://api.anthropic.com/v1/messages", ...)` calls in the app work unauthenticated
  inside the claude.ai artifact because that environment handles auth invisibly — that mechanism
  does not exist outside it. Build a thin backend proxy (a Supabase Edge Function, same pattern
  as the existing news function, is the natural choice given the project's already set up) that
  holds the real Anthropic key server-side and the app calls instead of hitting Anthropic
  directly.
- Recommended hosts: Vercel or Netlify — both fit this app's shape well and have workable free
  tiers for initial testing.
- Deploy, test privately (owner, then a couple of friends) before any wider sharing.

### Phase 2 — migrate to Option C (accounts + usage limits)

Once Phase 1 has real traffic and real usage patterns, add lightweight auth and per-person caps
rather than leaving the shared key open-ended.

- Supabase Auth is the natural fit (same project, no new service to introduce).
- Cap usage per person per day/month — exact numbers should come from **actual Phase 1 usage
  data**, not a guess made before launch. See the logging note below.
- Requests from users over their limit should fail gracefully client-side (the app already has
  established error-handling and fallback patterns throughout — follow those, don't bolt on a
  different error style for this).

### Architecture note for a smooth Phase 1 → Phase 2 transition

Structure Phase 1's backend proxy so Phase 2 is "add a check in front of the same call," not
"rebuild where the key lives." Concretely:

- Keep ALL Anthropic calls routed through one backend function from day one, even in Phase 1
  before any limits exist. Don't let the Phase 1 client call Anthropic directly for some
  requests and the proxy for others.
- **Log requests from Phase 1 onward** — timestamp, an anonymous session/visitor identifier,
  which endpoint (root topic, branch expansion, article, continuation). Doesn't need to block or
  limit anything yet. This is what makes Phase 2's actual limit numbers a real decision instead
  of a guess, and it's much cheaper to add this logging on day one than to retrofit it later once
  you actually want to know what "typical usage" looks like.
- Design the auth check in Phase 2 as middleware in front of the existing proxy function, not a
  parallel path.

## Known cost baseline

Rough estimate, Sonnet 5 pricing ($2/$10 per million input/output tokens): **15–50 cents per
person per hour** of active use, depending on how fast someone taps through topics. This is an
estimate from prompt/response token counts, not measured production data — Phase 1's logging
(see above) should replace this with real numbers before Phase 2's limits get set.

## Things NOT to change without a real reason

- The fixed "unhinged" tone and its explicit no-first-person / no-markdown rules — these came
  from real iteration and real bugs (a markdown-stripping bug specifically, from an earlier
  version of the tone that invited literal asterisks into the output).
- The obscurity dial's five fixed levels and their wording, especially the top tier's "wild
  associative leap" framing (tissue-paper-to-fly-wings style connections) — written deliberately
  to produce genuinely surprising branches, not vague "make it interesting" phrasing.
- The "dig deeper" continuation cap of one extra round per node — deliberate, not a limit to
  relax; this app is entertainment, not exhaustive research, by design.
- `normalizeChildren`'s overflow-capping logic — the model doesn't always follow exact count
  instructions, this silently corrects it. Don't remove it as "unnecessary defensive code."
