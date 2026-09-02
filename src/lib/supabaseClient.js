// Auth only. Every other call this app makes talks to Supabase over plain
// REST with the anon key (see api.js, App.jsx's trending-topics fetch)
// rather than this SDK, to keep the app's existing patterns unchanged —
// this client exists specifically because hand-rolling magic-link /
// session-refresh / PKCE correctly is real, security-relevant work the SDK
// already does safely. Not worth reinventing that for the sake of avoiding
// one dependency.
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
