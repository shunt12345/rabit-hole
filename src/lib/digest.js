// Email-only sign-up for the daily digest (no account needed). The server
// side is supabase/functions/digest-subscribe, which emails a confirm link;
// the address only gets the digest once that's clicked.
import { getAttribution } from "./attribution.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SUBSCRIBE_URL = `${SUPABASE_URL}/functions/v1/digest-subscribe`;
// Remembers, in this browser, that someone already signed up, so the box
// stops asking.
const SIGNED_UP_KEY = "hyfax-digest-signed-up";

export async function subscribeToDigest(email, source) {
  const res = await fetch(SUBSCRIBE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ email, source, utmSource: getAttribution().utmSource || null }),
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    // fall through to the generic message
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again in a moment.");
  markDigestSignedUp();
}

export function hasDigestSignup() {
  try {
    return localStorage.getItem(SIGNED_UP_KEY) === "1";
  } catch (_) {
    return false;
  }
}

export function markDigestSignedUp() {
  try {
    localStorage.setItem(SIGNED_UP_KEY, "1");
  } catch (_) {
    // storage unavailable — the box will just show again next visit
  }
}
