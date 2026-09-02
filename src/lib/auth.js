// Passwordless (magic link) — no password to manage, reset, or leak,
// matching the low-friction posture the monetization plan settled on
// (loose gating, signup pitched as a value-add rather than a wall — see
// the monetization outline doc, Section 14.2). Supabase Auth sends this
// email itself, built in — separate from and unrelated to the future
// daily-digest email integration (punch list Section E), which needs its
// own provider. Nothing new to configure for this beyond Supabase's own
// Auth "Redirect URLs" setting for this deployed domain.
import { supabase } from "./supabaseClient.js";

export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getCurrentUser() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.user ?? null;
}

// Fires on sign-in, sign-out, and token refresh — callback receives the
// current user (or null once signed out).
export function onAuthStateChange(callback) {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
  return () => subscription.unsubscribe();
}
