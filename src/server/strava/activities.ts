import { supabaseAdmin } from '@/lib/db';
import { decryptToken, encryptToken } from '@/lib/crypto';
import { refreshAccessToken } from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Thrown when fetchRecentActivities fails because the Strava token expired or
 * was revoked. The worker's Strava-fetch script catches it and surfaces the gap
 * to the athlete rather than coaching on stale data (SPEC §5.5).
 */
export class StravaTokenBrokenError extends Error {
  constructor(cause?: unknown) {
    super('Strava token refresh failed or was revoked');
    this.name = 'StravaTokenBrokenError';
    if (cause instanceof Error) this.cause = cause;
  }
}

export type StravaActivitySummary = {
  id: number;
  name: string;
  type: string; // "Run", "TrailRun", "VirtualRun", etc.
  start_date_local: string; // ISO datetime in athlete's local time
  timezone: string; // Strava format, e.g. "(GMT-08:00) America/Los_Angeles" ("" if absent)
  distance_m: number;
  moving_time_s: number;
  elapsed_time_s: number;
  total_elevation_gain_m: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  average_speed_mps: number;
};

/**
 * The authenticated athlete's Strava profile (GET /athlete). Any field can be
 * null — Strava lets users hide profile data via privacy settings.
 */
export type StravaProfile = {
  firstname: string | null;
  lastname: string | null;
  sex: 'M' | 'F' | null;
  city: string | null;
  state: string | null;
  country: string | null;
  weight_kg: number | null;
  measurement_preference: 'feet' | 'meters' | null;
};

/**
 * An 8-week training snapshot derived from recent Strava activities. Feeds the
 * onboarding-v2 button pre-fills (experience tier, days/week, long-run day) and
 * the template plan-gen scaling. Pure derivation — no DB or memory writes.
 *
 * A connected athlete with no recent activities yields a snapshot with
 * activity_count === 0 (so callers can fall back to asking); an athlete with no
 * Strava connection at all yields null from getFitnessSnapshot.
 */
export type StravaFitnessSnapshot = {
  window_days: number;
  activity_count: number;
  run_count: number;
  weeks_observed: number; // distinct calendar weeks in the window with >=1 run
  recent_weekly_mileage_mi: number; // trailing 4-week avg
  avg_weekly_mileage_mi: number; // full-window avg
  longest_run_mi: number;
  runs_per_week: number; // avg run-days per week over the window
  suggested_days_per_week: number; // clamped 3-6 recommendation
  dominant_long_run_weekday: number | null; // 0=Sun..6=Sat, mode of weekly-longest; null if unclear
  road_trail_mix: { road: number; trail: number };
};

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/**
 * Loads, validates, and (if needed) refreshes the Strava access token for an
 * athlete. Returns the decrypted access token string, or null if the athlete
 * has no connected Strava account.
 */
export async function getAccessToken(athleteId: string): Promise<string | null> {
  const db = supabaseAdmin();
  const { data } = await db
    .from('oauth_tokens')
    .select('access_token_enc, refresh_token_enc, expires_at')
    .eq('athlete_id', athleteId)
    .eq('provider', 'strava')
    .maybeSingle();

  if (!data) return null;

  const expiresAt = new Date(data.expires_at).getTime();
  const nowPlusFiveMin = Date.now() + 5 * 60 * 1000;

  if (expiresAt > nowPlusFiveMin) {
    // Token is still valid.
    return decryptToken(data.access_token_enc);
  }

  // Token is expired or about to expire — refresh it.
  const refreshToken = await decryptToken(data.refresh_token_enc);
  const refreshed = await refreshAccessToken(refreshToken);

  // Re-encrypt and persist.
  const [newAccessEnc, newRefreshEnc] = await Promise.all([
    encryptToken(refreshed.access_token),
    encryptToken(refreshed.refresh_token),
  ]);

  await db
    .from('oauth_tokens')
    .update({
      access_token_enc: newAccessEnc,
      refresh_token_enc: newRefreshEnc,
      expires_at: new Date(refreshed.expires_at * 1000).toISOString(),
    })
    .eq('athlete_id', athleteId)
    .eq('provider', 'strava');

  return refreshed.access_token;
}

// ---------------------------------------------------------------------------
// Strava API call
// ---------------------------------------------------------------------------

const STRAVA_API_BASE = 'https://www.strava.com/api/v3';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapActivity(raw: any): StravaActivitySummary {
  return {
    id: raw.id,
    name: raw.name ?? '',
    type: raw.sport_type ?? raw.type ?? 'Unknown',
    start_date_local: raw.start_date_local ?? raw.start_date ?? '',
    timezone: raw.timezone ?? '',
    distance_m: raw.distance ?? 0,
    moving_time_s: raw.moving_time ?? 0,
    elapsed_time_s: raw.elapsed_time ?? 0,
    total_elevation_gain_m: raw.total_elevation_gain ?? 0,
    average_heartrate: raw.average_heartrate ?? null,
    max_heartrate: raw.max_heartrate ?? null,
    average_speed_mps: raw.average_speed ?? 0,
  };
}

async function callStravaActivities(
  accessToken: string,
  afterUnix: number,
  perPage = 50,
  page = 1,
): Promise<StravaActivitySummary[]> {
  const url = `${STRAVA_API_BASE}/athlete/activities?after=${afterUnix}&per_page=${perPage}&page=${page}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    // Caller will handle the 401 case by retrying after refresh.
    throw Object.assign(new Error('Strava 401 Unauthorized'), { status: 401 });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Strava activities fetch failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return (Array.isArray(data) ? data : []).map(mapActivity);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the athlete has a Strava oauth_tokens row on file.
 *
 * Does not decrypt or validate the token. Use this to distinguish
 * "no connection" from "connected but no recent activities" before
 * calling fetchRecentActivities — the latter returns [] silently for
 * both cases, which is ambiguous.
 */
export async function hasStravaConnection(athleteId: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from('oauth_tokens')
    .select('id')
    .eq('athlete_id', athleteId)
    .eq('provider', 'strava')
    .maybeSingle();
  return !!data;
}

/**
 * Returns the last `days` days of Strava activities for an athlete.
 *
 * Returns an empty array if:
 * - The athlete has no connected Strava account.
 * - There are no activities in the window.
 *
 * Throws on non-401 Strava errors or token decrypt failures.
 */
export async function fetchRecentActivities(
  athleteId: string,
  days = 14,
  perPage = 50,
): Promise<StravaActivitySummary[]> {
  const afterUnix = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

  let accessToken = await getAccessToken(athleteId);
  if (!accessToken) return [];

  try {
    return await callStravaActivities(accessToken, afterUnix, perPage);
  } catch (err: unknown) {
    // On 401, try one token refresh + retry.
    const errStatus = (err as { status?: number }).status;
    if (errStatus === 401) {
      // Re-fetch with a forced refresh: clear the cached token expiry by
      // setting a past expires_at so getAccessToken will refresh.
      const db = supabaseAdmin();
      await db
        .from('oauth_tokens')
        .update({ expires_at: new Date(0).toISOString() })
        .eq('athlete_id', athleteId)
        .eq('provider', 'strava');

      accessToken = await getAccessToken(athleteId);
      if (!accessToken) return [];
      return await callStravaActivities(accessToken, afterUnix, perPage);
    }
    throw err;
  }
}

// How many pages fetchActivitiesSince will pull before giving up. A backstop
// against an unbounded loop, not a real limit: 5 × 200 = 1000 activities covers
// any marathon build many times over.
const MAX_BUILD_PAGES = 5;
const BUILD_PER_PAGE = 200;

/**
 * Returns every activity since `sinceISO` (a YYYY-MM-DD plan-start date),
 * paginating until a short page or the page cap. Readiness v2's realized series
 * needs the full build, which can overflow one page.
 *
 * Why paginate: Strava returns `after=` results oldest-first, so a single
 * capped page would drop the MOST RECENT weeks — exactly the ones the realized
 * long-run rung depends on. Mirrors fetchRecentActivities' token + 401 handling.
 *
 * Returns [] if the athlete has no connected Strava account. Throws on non-401
 * Strava errors or token decrypt failures (the caller degrades to v1).
 */
export async function fetchActivitiesSince(
  athleteId: string,
  sinceISO: string,
): Promise<StravaActivitySummary[]> {
  const afterUnix = Math.floor(Date.parse(`${sinceISO}T00:00:00Z`) / 1000);

  let accessToken = await getAccessToken(athleteId);
  if (!accessToken) return [];

  const all: StravaActivitySummary[] = [];
  for (let page = 1; page <= MAX_BUILD_PAGES; page++) {
    let batch: StravaActivitySummary[];
    try {
      batch = await callStravaActivities(accessToken, afterUnix, BUILD_PER_PAGE, page);
    } catch (err: unknown) {
      // On 401, force one token refresh + retry this page (same as fetchRecentActivities).
      if ((err as { status?: number }).status !== 401) throw err;
      const db = supabaseAdmin();
      await db
        .from('oauth_tokens')
        .update({ expires_at: new Date(0).toISOString() })
        .eq('athlete_id', athleteId)
        .eq('provider', 'strava');
      accessToken = await getAccessToken(athleteId);
      if (!accessToken) return all;
      batch = await callStravaActivities(accessToken, afterUnix, BUILD_PER_PAGE, page);
    }
    all.push(...batch);
    if (batch.length < BUILD_PER_PAGE) break; // last page
  }
  return all;
}

// ---------------------------------------------------------------------------
// Athlete profile (GET /athlete)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapProfile(raw: any): StravaProfile {
  const sex = raw.sex === 'M' || raw.sex === 'F' ? raw.sex : null;
  const pref =
    raw.measurement_preference === 'feet' || raw.measurement_preference === 'meters'
      ? raw.measurement_preference
      : null;
  return {
    firstname: raw.firstname ?? null,
    lastname: raw.lastname ?? null,
    sex,
    city: raw.city ?? null,
    state: raw.state ?? null,
    country: raw.country ?? null,
    weight_kg: typeof raw.weight === 'number' ? raw.weight : null,
    measurement_preference: pref,
  };
}

async function callStravaAthlete(accessToken: string): Promise<StravaProfile> {
  const res = await fetch(`${STRAVA_API_BASE}/athlete`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    throw Object.assign(new Error('Strava 401 Unauthorized'), { status: 401 });
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Strava athlete fetch failed (${res.status}): ${body}`);
  }

  return mapProfile(await res.json());
}

/**
 * Returns the authenticated athlete's Strava profile, or null if the athlete
 * has no connected Strava account.
 *
 * Any profile field may be null (privacy settings). Throws StravaTokenBrokenError
 * if the token can't be refreshed past a 401 — the caller should surface the
 * broken connection rather than treat missing profile data as fact.
 */
export async function getLoggedInAthlete(athleteId: string): Promise<StravaProfile | null> {
  let accessToken = await getAccessToken(athleteId);
  if (!accessToken) return null;

  try {
    return await callStravaAthlete(accessToken);
  } catch (err: unknown) {
    if ((err as { status?: number }).status !== 401) throw err;

    // Force a refresh and retry once.
    const db = supabaseAdmin();
    await db
      .from('oauth_tokens')
      .update({ expires_at: new Date(0).toISOString() })
      .eq('athlete_id', athleteId)
      .eq('provider', 'strava');

    accessToken = await getAccessToken(athleteId);
    if (!accessToken) return null;

    try {
      return await callStravaAthlete(accessToken);
    } catch (retryErr: unknown) {
      if ((retryErr as { status?: number }).status === 401) {
        throw new StravaTokenBrokenError(retryErr);
      }
      throw retryErr;
    }
  }
}

// ---------------------------------------------------------------------------
// Fitness snapshot
// ---------------------------------------------------------------------------

const METERS_PER_MILE = 1609.344;
const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Local calendar date (YYYY-MM-DD) of a Strava start_date_local string. */
function localDate(startDateLocal: string): string {
  return startDateLocal.slice(0, 10);
}

/** Weekday of a YYYY-MM-DD date, 0=Sun..6=Sat, tz-independent. */
function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** Monday-anchored week key (YYYY-MM-DD of that week's Monday) for bucketing. */
function weekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/**
 * Derives an 8-week training snapshot from recent Strava activities for the
 * onboarding-v2 pre-fills. Returns null only if the athlete has no Strava
 * connection; a connected athlete with no activities yields a zero-count
 * snapshot.
 */
export async function getFitnessSnapshot(
  athleteId: string,
  days = 56,
): Promise<StravaFitnessSnapshot | null> {
  if (!(await hasStravaConnection(athleteId))) return null;

  // per_page=200 (Strava's max) covers 8 weeks for all but double-day runners.
  const activities = await fetchRecentActivities(athleteId, days, 200);
  const runs = activities.filter((a) => RUN_TYPES.has(a.type));

  const empty: StravaFitnessSnapshot = {
    window_days: days,
    activity_count: activities.length,
    run_count: runs.length,
    weeks_observed: 0,
    recent_weekly_mileage_mi: 0,
    avg_weekly_mileage_mi: 0,
    longest_run_mi: 0,
    runs_per_week: 0,
    suggested_days_per_week: 3,
    dominant_long_run_weekday: null,
    road_trail_mix: { road: 0, trail: 0 },
  };
  if (runs.length === 0) return empty;

  const windowWeeks = Math.max(1, Math.round(days / 7));
  const recentCutoff = Date.now() - 28 * 24 * 60 * 60 * 1000;

  let totalMeters = 0;
  let recentMeters = 0;
  let longestMeters = 0;
  let road = 0;
  let trail = 0;
  const runDays = new Set<string>();
  const observedWeeks = new Set<string>();
  // week key -> { weekday, distance } of that week's longest run
  const weeklyLongest = new Map<string, { weekday: number; distance: number }>();

  for (const a of runs) {
    const date = localDate(a.start_date_local);
    totalMeters += a.distance_m;
    if (new Date(a.start_date_local).getTime() >= recentCutoff) recentMeters += a.distance_m;
    if (a.distance_m > longestMeters) longestMeters = a.distance_m;
    if (a.type === 'TrailRun') trail += 1;
    else road += 1;
    runDays.add(date);

    const wk = weekKey(date);
    observedWeeks.add(wk);
    const cur = weeklyLongest.get(wk);
    if (!cur || a.distance_m > cur.distance) {
      weeklyLongest.set(wk, { weekday: weekdayOf(date), distance: a.distance_m });
    }
  }

  // Mode of each week's longest-run weekday.
  const weekdayCounts = new Array<number>(7).fill(0);
  for (const { weekday } of weeklyLongest.values()) {
    weekdayCounts[weekday] = (weekdayCounts[weekday] ?? 0) + 1;
  }
  let dominantWeekday: number | null = null;
  let best = 0;
  for (let d = 0; d < 7; d++) {
    const count = weekdayCounts[d] ?? 0;
    if (count > best) {
      best = count;
      dominantWeekday = d;
    }
  }

  const runsPerWeek = round1(runDays.size / windowWeeks);
  const suggestedDays = Math.min(6, Math.max(3, Math.round(runDays.size / windowWeeks)));

  return {
    window_days: days,
    activity_count: activities.length,
    run_count: runs.length,
    weeks_observed: observedWeeks.size,
    recent_weekly_mileage_mi: round1(recentMeters / METERS_PER_MILE / 4),
    avg_weekly_mileage_mi: round1(totalMeters / METERS_PER_MILE / windowWeeks),
    longest_run_mi: round1(longestMeters / METERS_PER_MILE),
    runs_per_week: runsPerWeek,
    suggested_days_per_week: suggestedDays,
    dominant_long_run_weekday: dominantWeekday,
    road_trail_mix: { road, trail },
  };
}

// ---------------------------------------------------------------------------
// Timezone derivation
// ---------------------------------------------------------------------------

/**
 * Derives an IANA timezone (e.g. "America/Los_Angeles") from the most recent
 * activity's Strava timezone field ("(GMT-08:00) America/Los_Angeles").
 *
 * Returns null when no activity carries a parseable timezone — onboarding then
 * asks/confirms rather than guessing. The `profile` argument is accepted for a
 * future city-based fallback; city->IANA mapping is intentionally not done here
 * (it needs a dataset and isn't worth a dependency for the zero-activity edge).
 */
export function deriveTimezone(
  activities: StravaActivitySummary[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  profile?: StravaProfile | null,
): string | null {
  const withTz = activities
    .filter((a) => a.timezone && a.start_date_local)
    .sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));

  for (const a of withTz) {
    const match = a.timezone.match(/\)\s*(\S+)\s*$/);
    const iana = match?.[1];
    if (iana && iana.includes('/')) return iana;
  }
  return null;
}
