// Supabase Edge Function: digest-subscribe
//
// Email-only sign-up for the daily digest — no account needed. Three jobs:
//   POST {email, source, utmSource}  → saves the address as 'pending' and
//                                       emails a confirm link
//   GET  ?confirm=<token>             → the confirm link: marks it
//                                       'confirmed', then send-daily-digest
//                                       includes it
//   GET/POST ?unsub=<id>&token=<hmac> → the digest's unsubscribe link (and
//                                       Gmail's one-click unsubscribe)
// The two links redirect back to the app (?digest=confirmed /
// ?digest=unsubscribed), which shows a short notice.
//
// Double opt-in keeps anyone from signing up someone else's address, and
// keeps the list clean for Gmail. The POST answers the same way whether or
// not the address is already on the list, so it can't be used to check who
// subscribes.
//
// Table: digest_subscribers (migration 0062). Reads the same project
// secrets the digest already uses (RESEND_API_KEY, EMAIL_UNSUB_SECRET).
//
// DEPLOY: supabase functions deploy digest-subscribe --no-verify-jwt
//   (the confirm and unsubscribe links are plain clicks from an email, with
//   no sign-in; they carry the anon key as ?apikey= like unsubscribe-email)
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://www.hyfax.app";
const DIGEST_FROM = Deno.env.get("DIGEST_FROM_EMAIL") ?? "Hyfax <hello@hyfax.app>";
const FUNCTION_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/digest-subscribe`;

const ALLOWED_ORIGINS = (
  Deno.env.get("ALLOWED_ORIGINS") ?? "https://hyfax.app,https://hyfa-x.vercel.app,http://localhost:5173,http://localhost:5183"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function corsHeadersFor(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Sign-ups allowed from one IP per hour, and the wait before a pending
// address can be sent another confirm email.
const MAX_SIGNUPS_PER_IP_HOUR = 5;
const RESEND_CONFIRM_AFTER_MS = 10 * 60 * 1000;

function getClientIp(req: Request): string | null {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip");
}

// Same check send-daily-digest builds the subscriber's unsubscribe link with.
async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function backToApp(result: string) {
  return new Response(null, { status: 302, headers: { Location: `${APP_ORIGIN}/?digest=${result}` } });
}

function confirmEmailHtml(confirmUrl: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#14100C;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px; width:100%; background-color:#1F1811; border-radius:16px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <tr>
          <td style="padding:32px 40px 8px; text-align:center;">
            <img src="${APP_ORIGIN}/hyfax-logo.png" width="110" alt="Hyfax" style="display:block; margin:0 auto; border:0; height:auto;" />
            <div style="margin-top:8px; font-family:'Courier New',monospace; font-size:10px; letter-spacing:3px; text-transform:uppercase; color:#A89478;">thinking with threads</div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 8px; text-align:center;">
            <p style="margin:0; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:20px; line-height:1.4; color:#F1E6D3;">One tap and you're in.</p>
            <p style="margin:12px 0 0; font-size:14px; line-height:1.6; color:#B8A886;">Confirm your email to get Hyfax's daily threads: a quote, a moment in history, a word, a riddle and what's trending, every morning.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 32px; text-align:center;">
            <a href="${confirmUrl}" style="display:inline-block; padding:12px 28px; border-radius:999px; background-color:#E3A73C; color:#14100C; font-size:14px; font-weight:600; text-decoration:none;">Confirm my email</a>
            <p style="margin:20px 0 0; font-size:12px; line-height:1.6; color:#A89478;">Didn't ask for this? Ignore this email and you won't hear from us.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

async function sendConfirmEmail(apiKey: string, to: string, token: string) {
  const confirmUrl = `${FUNCTION_URL}?confirm=${token}&apikey=${Deno.env.get("SUPABASE_ANON_KEY")}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: DIGEST_FROM,
      to,
      subject: "Confirm your daily threads from Hyfax",
      html: confirmEmailHtml(confirmUrl),
      text: `Confirm your email to get Hyfax's daily threads every morning:\n${confirmUrl}\n\nDidn't ask for this? Ignore this email and you won't hear from us.`,
    }),
  });
  if (!res.ok) throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  try {
    // Confirm link.
    const confirm = url.searchParams.get("confirm");
    if (confirm) {
      if (!/^[0-9a-f-]{36}$/i.test(confirm)) return backToApp("invalid");
      const { data: row } = await supabase.from("digest_subscribers").select("id, status").eq("confirm_token", confirm).maybeSingle();
      if (!row) return backToApp("invalid");
      if (row.status !== "confirmed") {
        await supabase
          .from("digest_subscribers")
          .update({ status: "confirmed", confirmed_at: new Date().toISOString(), unsubscribed_at: null })
          .eq("id", row.id);
      }
      return backToApp("confirmed");
    }

    // Unsubscribe link (GET from the footer, POST from Gmail's one-click).
    const unsub = url.searchParams.get("unsub");
    if (unsub) {
      const secret = Deno.env.get("EMAIL_UNSUB_SECRET");
      const token = url.searchParams.get("token") ?? "";
      if (!secret || token !== (await hmacHex(secret, `subscriber:${unsub}`))) return backToApp("invalid");
      await supabase
        .from("digest_subscribers")
        .update({ status: "unsubscribed", unsubscribed_at: new Date().toISOString() })
        .eq("id", unsub);
      return req.method === "POST" ? new Response("ok") : backToApp("unsubscribed");
    }

    if (req.method !== "POST") return json({ error: "not_found" }, 404, cors);

    // Sign-up.
    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return json({ error: "That doesn't look like an email address." }, 400, cors);
    }
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) return json({ error: "Sign-up isn't available right now." }, 500, cors);

    const ip = getClientIp(req);
    if (ip) {
      const { count } = await supabase
        .from("digest_subscribers")
        .select("id", { count: "exact", head: true })
        .eq("ip_address", ip)
        .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
      if ((count ?? 0) >= MAX_SIGNUPS_PER_IP_HOUR) {
        return json({ error: "Too many sign-ups from here. Try again in an hour." }, 429, cors);
      }
    }

    const source = typeof body.source === "string" ? body.source.slice(0, 40) : null;
    const utmSource = typeof body.utmSource === "string" ? body.utmSource.slice(0, 80) : null;
    const { data: existing } = await supabase
      .from("digest_subscribers")
      .select("id, status, confirm_token, confirm_sent_at")
      .eq("email", email)
      .maybeSingle();

    if (!existing) {
      const { data: created, error } = await supabase
        .from("digest_subscribers")
        .insert({ email, source, utm_source: utmSource, ip_address: ip, confirm_sent_at: new Date().toISOString() })
        .select("confirm_token")
        .single();
      if (error) throw error;
      await sendConfirmEmail(resendApiKey, email, created.confirm_token);
    } else if (existing.status !== "confirmed") {
      // Pending or unsubscribed: send a confirm link again, but not more
      // than once every 10 minutes.
      const lastSent = existing.confirm_sent_at ? new Date(existing.confirm_sent_at).getTime() : 0;
      if (Date.now() - lastSent > RESEND_CONFIRM_AFTER_MS) {
        await supabase
          .from("digest_subscribers")
          .update({ status: "pending", confirm_sent_at: new Date().toISOString() })
          .eq("id", existing.id);
        await sendConfirmEmail(resendApiKey, email, existing.confirm_token);
      }
    }
    // Already confirmed: nothing to send, same answer.
    return json({ ok: true }, 200, cors);
  } catch (e) {
    console.error("digest-subscribe: unexpected error", e);
    return json({ error: "Something went wrong. Try again in a moment." }, 500, cors);
  }
});
