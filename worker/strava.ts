// Builds the Strava context the coach reads each run. Wraps the existing
// client (M1 plan §6) — does not reimplement Strava.
//
// The worker pre-fetches this into the athlete folder as `strava_recent.json`
// before the agent runs, so the agent reads a file rather than spawning Bash.
// The shape is JSON the coach can reason over directly.

import { supabaseAdmin } from '@/lib/db';
import { bucketRealizedSeries, type RealizedWeek } from '@/lib/plan-drift';
import type { Plan } from '@/lib/plan-schema';
import {
  fetchActivitiesSince,
  fetchRecentActivities,
  hasStravaConnection,
  StravaTokenBrokenError,
  type StravaActivitySummary,
} from '@/server/strava/activities';

export type StravaWindowSummary = {
  days: number;
  activity_count: number;
  total_distance_mi: number;
  total_moving_time_min: number;
};

export type StravaContext = {
  connected: boolean;
  // True when the athlete has a connection but the token is broken/revoked, or
  // a Strava error blocked the pull. The coach surfaces the gap explicitly
  // rather than coaching on stale data (SPEC §5.5).
  broken: boolean;
  error: string | null;
  fetched_at: string;
  activities: StravaActivitySummary[];
  summary_7d: StravaWindowSummary | null;
  summary_28d: StravaWindowSummary | null;
};

const METERS_PER_MILE = 1609.344;

function summarize(activities: StravaActivitySummary[], days: number): StravaWindowSummary {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const inWindow = activities.filter((a) => {
    const t = new Date(a.start_date_local).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  const totalMeters = inWindow.reduce((sum, a) => sum + a.distance_m, 0);
  const totalSeconds = inWindow.reduce((sum, a) => sum + a.moving_time_s, 0);
  return {
    days,
    activity_count: inWindow.length,
    total_distance_mi: round1(totalMeters / METERS_PER_MILE),
    total_moving_time_min: Math.round(totalSeconds / 60),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function buildStravaContext(
  athleteId: string,
  days: number,
): Promise<StravaContext> {
  const fetchedAt = new Date().toISOString();
  const connected = await hasStravaConnection(athleteId);
  if (!connected) {
    return {
      connected: false,
      broken: false,
      error: null,
      fetched_at: fetchedAt,
      activities: [],
      summary_7d: null,
      summary_28d: null,
    };
  }

  try {
    const activities = await fetchRecentActivities(athleteId, days);
    return {
      connected: true,
      broken: false,
      error: null,
      fetched_at: fetchedAt,
      activities,
      summary_7d: summarize(activities, 7),
      summary_28d: summarize(activities, 28),
    };
  } catch (err) {
    // Token-broken and transient Strava errors both degrade to "broken" so the
    // run completes and the coach flags the gap. We do not retry-loop here.
    const message =
      err instanceof StravaTokenBrokenError
        ? 'Strava token expired or was revoked.'
        : err instanceof Error
          ? err.message
          : 'Unknown Strava error.';
    return {
      connected: true,
      broken: true,
      error: message,
      fetched_at: fetchedAt,
      activities: [],
      summary_7d: null,
      summary_28d: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Readiness v2 — the realized per-week long-run series (Specs/READINESS_V2.md).
//
// computeReadiness reads this to ground the verdict in what the athlete actually
// ran. It needs the whole build (12–18+ weeks), which is a paginated Strava
// fetch — too expensive to repeat on every hydrate (an inbound message triggers
// a run). So it's cached once per athlete per day in strava_realized_cache and
// recomputed only when the day rolls or the plan version changes.
// ---------------------------------------------------------------------------

/**
 * Returns the realized per-week series for the athlete's current build, reading
 * the once-per-day cache and recomputing on a miss. Returns null — so readiness
 * degrades to v1 (plan-only) — when there's no datable plan, no Strava
 * connection, the Strava pull fails, or the plan can't be bucketed.
 *
 * `today` is the athlete-local YYYY-MM-DD (the cache's per-day key).
 */
export async function buildRealizedSeries(
  athleteId: string,
  plan: Plan | null,
  planVersionId: string | null,
  today: string,
): Promise<RealizedWeek[] | null> {
  if (!plan || !planVersionId) return null;
  const planStart = plan.metadata?.plan_structure?.start_date;
  if (!planStart) return null;

  const db = supabaseAdmin();

  // Cache hit: same athlete-local day AND same working plan version (a plan edit
  // re-buckets). The series only changes on a new activity, so daily is plenty.
  const { data: cached } = await db
    .from('strava_realized_cache')
    .select('plan_version_id, computed_date, series')
    .eq('athlete_id', athleteId)
    .maybeSingle();
  if (cached && cached.computed_date === today && cached.plan_version_id === planVersionId) {
    return cached.series as RealizedWeek[];
  }

  // Miss: pull the build window and reduce it. A broken/disconnected Strava (or a
  // plan we can't bucket) degrades to v1 — and we don't poison the cache with it.
  if (!(await hasStravaConnection(athleteId))) return null;
  let activities: StravaActivitySummary[];
  try {
    activities = await fetchActivitiesSince(athleteId, planStart);
  } catch {
    return null;
  }

  const series = bucketRealizedSeries(plan, activities, today);
  if (series === null) return null;

  await db.from('strava_realized_cache').upsert(
    {
      athlete_id: athleteId,
      plan_version_id: planVersionId,
      computed_date: today,
      series,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'athlete_id' },
  );

  return series;
}
