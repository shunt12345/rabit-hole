# Hypha

A curiosity-driven exploration app: drop in a topic, get branches to explore
next (a mix of direct facts, adjacent ideas, and deliberately wild
tangential leaps), read a short AI-generated article per topic, keep
branching. Entertainment-first, not a research tool — the voice is
deliberately "unhinged" (breathless, energetic, witty).

Renamed from "Rabbit Hole" — the backend function/table names below
(`rabbit-hole-proxy`, `rabbit_hole_request_logs`) still use the original
name since renaming deployed Supabase infra is a separate, riskier change
that hasn't been done yet. They're the same backend, just pre-rename names.

This is the standalone version of an app that started as a single-file
React component inside a claude.ai artifact. See
[`docs/handoff.md`](docs/handoff.md) for the original handoff brief this
build follows, including the Phase 1 → Phase 2 plan and the things
deliberately left alone.

## Architecture

```
┌───────────────┐         ┌───────────────────────────┐         ┌────────────────┐
│  Browser        │ ─────▶ │  Supabase Edge Function     │ ─────▶ │  Anthropic API   │
│  (Vite + React) │        │  rabbit-hole-proxy           │        │  claude-sonnet-5 │
└───────────────┘         └───────────────────────────┘         └────────────────┘
```

The client never talks to Anthropic directly and never holds the real API
key. Every call goes through `rabbit-hole-proxy`, a Supabase Edge Function
that holds the key as a server-side secret, forwards the request, and
streams the response straight back. Each request is also logged
(`rabbit_hole_request_logs`: timestamp, anonymous session id, endpoint) so
Phase 2's usage limits can be set from real numbers instead of a guess.

## Local development

```
npm install
cp .env.example .env.local   # fill in your Supabase project's URL + anon key
npm run dev
```

The `.env.local` values are client-safe (the anon/publishable key, not a
secret) — see `.env.example`.

## Deploying the backend (Supabase)

1. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and log in.
2. Link this project's Supabase project (or create your own):
   ```
   supabase link --project-ref <your-project-ref>
   ```
3. Run the migration to create the request-log table:
   ```
   supabase db push
   ```
4. Set the real Anthropic key as a secret (never committed, never in client code):
   ```
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   ```
5. Deploy the proxy function:
   ```
   supabase functions deploy rabbit-hole-proxy
   ```
6. (Optional, not currently wired into the UI) deploy the news-chip function —
   see `supabase/functions/trending-topics/index.ts` for why it's dormant and
   the caveats around its deployed name.

## Deploying the frontend

Either Vercel or Netlify work well for a Vite app with no server-side
rendering needed:

**Vercel**
```
npm i -g vercel
vercel
```
Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as project environment
variables in the Vercel dashboard, matching `.env.example`.

**Netlify**
```
npm i -g netlify-cli
netlify deploy --build
```
Build command: `npm run build`, publish directory: `dist`. Set the same two
env vars in the Netlify dashboard.

Test privately (yourself, then a couple of friends) before sharing more
widely — this is Phase 1 (one shared key, no per-person limits yet).

## Cost baseline

Rough estimate at Sonnet 5 pricing ($2/$10 per million input/output
tokens): **15–50 cents per person per hour** of active use, depending on how
fast someone taps through topics. This is a token-count estimate, not
measured production data — the request-log table above is what replaces it
with real numbers before Phase 2's limits get set.

## Phase 2 (not yet built)

Add Supabase Auth and per-person daily/monthly usage caps, sized from
`rabbit_hole_request_logs` data collected during Phase 1. Implement the
limit check as middleware in front of the existing `rabbit-hole-proxy`
function rather than a parallel path, and fail gracefully client-side using
the app's existing error-handling patterns.

## Things not to change without a real reason

See `docs/handoff.md` for the full list and reasoning — in short: the fixed
"unhinged" tone and its no-first-person/no-markdown rules, the obscurity
mix's wording (especially the top tier's "wild associative leap" framing),
the one-extra-round cap on "dig deeper", and `normalizeChildren`'s
overflow-capping logic are all deliberate, not incidental.
