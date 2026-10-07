// Thin client for track-event (the Adoption analytics endpoint, see
// supabase/functions/track-event). Every call here is fire-and-forget —
// `keepalive: true` so the request survives a page navigation, never
// awaited by a caller, and every failure mode (no storage, no network,
// the function being down) is swallowed rather than surfaced — this is
// instrumentation, not core functionality, and must never be able to
// break or even visibly delay the app.
import { getVisitorId, isTestMode } from "./visitor.js";
import { getAttribution } from "./attribution.js";
import { getAccessToken } from "./auth.js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// `includeAuth: true` opportunistically attaches the current access
// token (if any) so track-event can link this visitor_id to a signed-in
// user_id — safe to pass on every call regardless of sign-in state,
// since getAccessToken() just resolves to null when signed out. Callers
// don't need to know or check whether the user is signed in.
export async function trackEvent(type, { page, sessionId, includeAuth = true } = {}) {
  try {
    const attribution = getAttribution();
    const accessToken = includeAuth ? await getAccessToken().catch(() => null) : null;
    const body = JSON.stringify({
      visitorId: getVisitorId(),
      sessionId,
      type,
      page: page || null,
      isTest: isTestMode(),
      utmSource: attribution.utmSource || null,
      utmCampaign: attribution.utmCampaign || null,
      utmContent: attribution.utmContent || null,
      rdtCid: attribution.rdtCid || null,
    });
    fetch(`${SUPABASE_URL}/functions/v1/track-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch (_) {
    // analytics must never break the app
  }
}
