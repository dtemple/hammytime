// Builds the Strava context the coach reads each run. Wraps the existing
// client (M1 plan §6) — does not reimplement Strava.
//
// The worker pre-fetches this into the athlete folder as `strava_recent.json`
// before the agent runs, so the agent reads a file rather than spawning Bash.
// The shape is JSON the coach can reason over directly.

import {
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
