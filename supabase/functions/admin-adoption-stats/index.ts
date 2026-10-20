// Supabase Edge Function: admin-adoption-stats
//
// Backs /admin's "Adoption" section (src/AdminDashboard.jsx) — the only way
// to read visitors/sessions/events (migration 0049) from the browser, since
// those tables have RLS enabled with no policies at all (service role
// only), same posture as rabbit_hole_request_logs. Admin-gated the same way
// admin-usage-stats is (ADMIN_USER_IDS, a Supabase secret, not a DB column).
//
// Self-contained like every other function in this project (no shared
// imports across functions) — the auth/CORS boilerplate below is the same
// copy admin-usage-stats/admin-review-queue/track-event each carry.
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const ADMIN_USER_IDS = new Set(
  (Deno.env.get("ADMIN_USER_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function unauthorized(corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The API hands back at most 1,000 rows per request (a .limit() above that
// is silently capped), so every read here pages through in 1,000-row steps.
const PAGE_ROWS = 1000;
// Visitor ids go in the request URL, which fails (500) once it holds a few
// hundred of them, so id lists are sent in batches this size.
const ID_BATCH = 150;

// deno-lint-ignore no-explicit-any
async function readAllRows<T>(page: (from: number, to: number) => PromiseLike<{ data: any; error: any }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE_ROWS) return rows;
  }
}

// Every row of `table` whose visitor_id is in `ids`, batched and paged
// (ordered by the table's key, so pages don't overlap or skip rows).
async function readForVisitors<T>(table: string, columns: string, key: string, ids: string[]): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    rows.push(
      ...(await readAllRows<T>((from, to) =>
        supabase.from(table).select(columns).in("visitor_id", batch).order(key).range(from, to)
      ))
    );
  }
  return rows;
}

const COHORT_TZ = "America/New_York";

// All of this app's "which calendar day does this timestamp fall on"
// reasoning for the Adoption section lives in NY time (see the brief's own
// "America/New_York" spec for the retention cohort table) — distinct from
// rabbit-hole-proxy-v2's per-VISITOR timeZone (used only for that
// visitor's own free-trial reset hour). Adoption numbers need one fixed
// reference clock so a cohort week means the same thing for every visitor
// regardless of where they are.
function nyDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: COHORT_TZ });
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Monday-starting week label for a given NY calendar date — the row key
// for the retention cohort table.
function mondayOfWeek(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const diff = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Same three-way split the brief asks each panel to filter by — "reddit"
// is its own bucket (the one ad channel this app runs), an empty
// first_source means a plain organic/bookmarked visit ("direct"), and
// anything else (another ad platform, a shared link's own utm_source,
// etc.) falls into "other" rather than fragmenting into a long one-off
// tail at this app's current traffic.
function channelOf(firstSource: string | null): "reddit" | "email" | "direct" | "other" {
  if (firstSource === "reddit") return "reddit";
  // The daily digest's own links (send-daily-digest tags them).
  if (firstSource === "email") return "email";
  if (!firstSource) return "direct";
  return "other";
}

type VisitorRow = {
  visitor_id: string;
  first_seen_at: string;
  first_source: string | null;
  first_campaign: string | null;
  user_id: string | null;
  is_test: boolean;
  variant: string | null;
};
type SessionRow = { session_id: string; visitor_id: string; started_at: string };
type EventRow = { visitor_id: string; session_id: string; type: string; created_at: string };

serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return unauthorized(corsHeaders);

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return unauthorized(corsHeaders);

    if (ADMIN_USER_IDS.size === 0 || !ADMIN_USER_IDS.has(userData.user.id)) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const sourceFilter = url.searchParams.get("source"); // "reddit" | "email" | "direct" | "other" | null
    const campaignFilter = url.searchParams.get("campaign");
    const includeTest = url.searchParams.get("includeTest") === "1";
    // The "cards" vs "scroll" test group (src/lib/variant.js); null = all.
    const variantParam = url.searchParams.get("variant");
    const variantFilter = variantParam === "cards" || variantParam === "scroll" ? variantParam : null;
    const now = new Date();
    const since = url.searchParams.get("since") || new Date(now.getTime() - 60 * DAY_MS).toISOString();
    const until = url.searchParams.get("until") || now.toISOString();
    const todayKey = nyDateKey(now.toISOString());

    // Scoped by source/campaign/is_test only (NOT by date) — new-vs-
    // returning and the retention cohort table both need visibility into
    // activity/membership that can fall outside [since, until] (a cohort's
    // Day 30 column, a returning visitor first seen weeks before this
    // window). The date range narrows which COHORTS/DAYS are displayed,
    // not which visitors are known about. Fine as one broad fetch
    // (aggregated in-process below) at this app's current scale — same
    // posture admin-usage-stats already takes for its own 30-day pull.
    const visitorRows = await readAllRows<VisitorRow>((from, to) => {
      let q = supabase
        .from("visitors")
        .select("visitor_id, first_seen_at, first_source, first_campaign, user_id, is_test, variant")
        .order("visitor_id")
        .range(from, to);
      if (!includeTest) q = q.eq("is_test", false);
      if (campaignFilter) q = q.eq("first_campaign", campaignFilter);
      return q;
    });

    // Source/campaign scope before the variant filter: the side-by-side
    // comparison below covers both groups whatever variant is picked.
    const channelVisitors = visitorRows.filter(
      (v) => !sourceFilter || channelOf(v.first_source) === sourceFilter
    );
    const scopedVisitors = channelVisitors.filter((v) => !variantFilter || v.variant === variantFilter);
    const scopedIds = scopedVisitors.map((v) => v.visitor_id);

    if (scopedIds.length === 0) {
      return new Response(
        JSON.stringify({
          filters: { source: sourceFilter, campaign: campaignFilter, since, until, includeTest, variant: variantFilter },
          funnel: { landed: 0, activated: 0, activatedByTap: 0, activatedByScroll: 0, deep: 0, signedUp: 0, activatedPct: 0, deepPct: 0, signedUpPct: 0 },
          variants: [],
          depth: { avgPagesPerSession: 0, medianPagesPerSession: 0, sessionCount: 0 },
          newVsReturning: [],
          retentionCohort: [],
          northStar: { thisWeekCount: 0, lastWeekCount: 0, changePct: null, weekStart: mondayOfWeek(todayKey) },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetched for every visitor in the source/campaign scope, so the
    // variant comparison has both groups even with a variant picked.
    const fetchIds = variantFilter ? channelVisitors.map((v) => v.visitor_id) : scopedIds;
    const [sessionRows, allEventRows] = await Promise.all([
      readForVisitors<SessionRow>("sessions", "session_id, visitor_id, started_at", "session_id", fetchIds),
      readForVisitors<EventRow>("events", "visitor_id, session_id, type, created_at", "id", fetchIds),
    ]);
    const scopedIdSet = new Set(scopedIds);
    const eventRows = variantFilter ? allEventRows.filter((e) => scopedIdSet.has(e.visitor_id)) : allEventRows;

    const sessionsByVisitor = new Map<string, SessionRow[]>();
    for (const s of sessionRows) {
      const arr = sessionsByVisitor.get(s.visitor_id) ?? [];
      arr.push(s);
      sessionsByVisitor.set(s.visitor_id, arr);
    }
    for (const arr of sessionsByVisitor.values()) arr.sort((a, b) => (a.started_at < b.started_at ? -1 : 1));

    const eventsBySession = new Map<string, EventRow[]>();
    const eventsByVisitor = new Map<string, EventRow[]>();
    for (const e of allEventRows) {
      const bySession = eventsBySession.get(e.session_id) ?? [];
      bySession.push(e);
      eventsBySession.set(e.session_id, bySession);
      const byVisitor = eventsByVisitor.get(e.visitor_id) ?? [];
      byVisitor.push(e);
      eventsByVisitor.set(e.visitor_id, byVisitor);
    }

    // ---- Funnel + Depth + Cost-helper inputs: visitors first seen within
    // [since, until] only (a cohort of "visitors who landed in this
    // period"), matching the acceptance test's "funnel for
    // utm_campaign=kitchen-crystals" over whatever date range is picked.
    // The funnel and depth for one set of visitors, first seen in
    // [since, until]. Activated is a first-session tap. scroll_continue (a
    // Why card the scroll group had opened for them by scrolling) isn't a
    // choice the reader made, so it's counted alongside, not as activation.
    function funnelFor(visitors: VisitorRow[]) {
      let landed = 0;
      let activated = 0;
      let activatedByTap = 0;
      let activatedByScroll = 0;
      let deep = 0;
      let signedUp = 0;
      const sessionPageCounts: number[] = [];
      for (const v of visitors) {
        if (v.first_seen_at < since || v.first_seen_at > until) continue;
        const sessions = sessionsByVisitor.get(v.visitor_id) ?? [];
        for (const s of sessions) {
          sessionPageCounts.push((eventsBySession.get(s.session_id) ?? []).filter((e) => e.type === "article_view").length);
        }
        const visitorEvents = eventsByVisitor.get(v.visitor_id) ?? [];
        if (!visitorEvents.some((e) => e.type === "land")) continue; // "Landed" means an actual land event was recorded, not just a row existing
        landed += 1;
        const firstSession = sessions[0];
        const firstSessionEvents = firstSession ? eventsBySession.get(firstSession.session_id) ?? [] : [];
        const tapped = firstSessionEvents.some((e) => e.type === "tap");
        const scrolled = firstSessionEvents.some((e) => e.type === "scroll_continue");
        if (tapped) activated += 1;
        if (tapped) activatedByTap += 1;
        if (scrolled) activatedByScroll += 1;
        if (firstSessionEvents.filter((e) => e.type === "article_view").length >= 3) deep += 1;
        if (v.user_id || visitorEvents.some((e) => e.type === "signup")) signedUp += 1;
      }
      return {
        funnel: {
          landed,
          activated,
          activatedByTap,
          activatedByScroll,
          deep,
          signedUp,
          activatedPct: landed ? activated / landed : 0,
          deepPct: landed ? deep / landed : 0,
          signedUpPct: landed ? signedUp / landed : 0,
        },
        depth: {
          avgPagesPerSession: sessionPageCounts.length ? sessionPageCounts.reduce((a, b) => a + b, 0) / sessionPageCounts.length : 0,
          medianPagesPerSession: median(sessionPageCounts),
          sessionCount: sessionPageCounts.length,
        },
      };
    }

    const { funnel, depth } = funnelFor(scopedVisitors);
    // Side by side, whatever variant filter is picked.
    const variants = (["cards", "scroll"] as const).map((name) => {
      const r = funnelFor(channelVisitors.filter((v) => v.variant === name));
      return { variant: name, ...r.funnel, pagesPerSession: r.depth.avgPagesPerSession };
    });

    // ---- New vs returning visitors per day — driven by actual activity
    // (any event) on a given NY calendar day, restricted to days inside
    // [since, until]; "returning" per the brief means first_seen_at falls
    // on an earlier calendar day than the activity itself, which is why
    // this reads from the full scopedVisitors set (not just those first seen in the window) —
    // a visitor first seen well before the window can still show up here
    // as a returning visit inside it.
    const sinceKey = nyDateKey(since);
    const untilKey = nyDateKey(until);
    const firstSeenKeyByVisitor = new Map(scopedVisitors.map((v) => [v.visitor_id, nyDateKey(v.first_seen_at)]));
    const activeDayMap = new Map<string, { new: Set<string>; returning: Set<string> }>();
    for (const e of eventRows) {
      const dayKey = nyDateKey(e.created_at);
      if (dayKey < sinceKey || dayKey > untilKey) continue;
      const firstSeenKey = firstSeenKeyByVisitor.get(e.visitor_id);
      if (!firstSeenKey) continue;
      const bucket = activeDayMap.get(dayKey) ?? { new: new Set<string>(), returning: new Set<string>() };
      if (firstSeenKey === dayKey) bucket.new.add(e.visitor_id);
      else if (firstSeenKey < dayKey) bucket.returning.add(e.visitor_id);
      activeDayMap.set(dayKey, bucket);
    }
    const newVsReturning = [...activeDayMap.entries()]
      .map(([day, b]) => ({ day, new: b.new.size, returning: b.returning.size }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));

    // ---- Retention cohort table — rows are the Monday of each visitor's
    // first-seen NY week, limited to cohorts whose first-seen week falls
    // in [since, until] (same window the funnel panel uses); columns check
    // for a session on first_seen+1/+7/+30 (NY calendar days), left null
    // when that day hasn't happened yet rather than counted as 0%.
    const cohortMap = new Map<string, { visitorIds: string[] }>();
    for (const v of scopedVisitors) {
      if (v.first_seen_at < since || v.first_seen_at > until) continue;
      const week = mondayOfWeek(nyDateKey(v.first_seen_at));
      const bucket = cohortMap.get(week) ?? { visitorIds: [] };
      bucket.visitorIds.push(v.visitor_id);
      cohortMap.set(week, bucket);
    }
    function dayNPct(visitorIds: string[], n: number): number | null {
      let eligible = 0;
      let returned = 0;
      for (const id of visitorIds) {
        const firstSeenKey = firstSeenKeyByVisitor.get(id);
        if (!firstSeenKey) continue;
        const targetKey = addDaysToDateKey(firstSeenKey, n);
        if (targetKey > todayKey) continue; // not enough time has passed yet for this visitor
        eligible += 1;
        const sessions = sessionsByVisitor.get(id) ?? [];
        if (sessions.some((s) => nyDateKey(s.started_at) === targetKey)) returned += 1;
      }
      return eligible ? returned / eligible : null;
    }
    const retentionCohort = [...cohortMap.entries()]
      .map(([week, b]) => ({
        week,
        cohortSize: b.visitorIds.length,
        day1Pct: dayNPct(b.visitorIds, 1),
        day7Pct: dayNPct(b.visitorIds, 7),
        day30Pct: dayNPct(b.visitorIds, 30),
      }))
      .sort((a, b) => (a.week < b.week ? -1 : 1));

    // ---- North-star tile — weekly active visitors (3+ pages that week),
    // this week vs last week, independent of [since, until] (it's always
    // "right now" vs "a week ago"), but still honors source/campaign/
    // is_test via scopedVisitors.
    const thisWeekStart = mondayOfWeek(todayKey);
    const lastWeekStart = addDaysToDateKey(thisWeekStart, -7);
    function weeklyActiveCount(weekStartKey: string): number {
      const weekEndKey = addDaysToDateKey(weekStartKey, 7); // exclusive
      const pageViewsByVisitor = new Map<string, number>();
      for (const e of eventRows) {
        if (e.type !== "article_view") continue;
        const dayKey = nyDateKey(e.created_at);
        if (dayKey < weekStartKey || dayKey >= weekEndKey) continue;
        pageViewsByVisitor.set(e.visitor_id, (pageViewsByVisitor.get(e.visitor_id) ?? 0) + 1);
      }
      let count = 0;
      for (const n of pageViewsByVisitor.values()) if (n >= 3) count += 1;
      return count;
    }
    const thisWeekCount = weeklyActiveCount(thisWeekStart);
    const lastWeekCount = weeklyActiveCount(lastWeekStart);
    const northStar = {
      thisWeekCount,
      lastWeekCount,
      changePct: lastWeekCount ? (thisWeekCount - lastWeekCount) / lastWeekCount : null,
      weekStart: thisWeekStart,
    };

    return new Response(
      JSON.stringify({
        filters: { source: sourceFilter, campaign: campaignFilter, since, until, includeTest, variant: variantFilter },
        funnel,
        depth,
        variants,
        newVsReturning,
        retentionCohort,
        northStar,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("admin-adoption-stats: unexpected error", e);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
