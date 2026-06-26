// Shared fixture helpers: reusable Strava snapshots and a frozen-race builder.

import type { StravaFitnessSnapshot } from '@/server/strava/activities';
import type { RaceLookupResult } from '@/server/agent/race-lookup';

/** A solid endurance base (reads as experienced; long runs Sunday). */
export function enduranceSnapshot(over: Partial<StravaFitnessSnapshot> = {}): StravaFitnessSnapshot {
  return {
    window_days: 90,
    activity_count: 50,
    run_count: 46,
    weeks_observed: 12,
    recent_weekly_mileage_mi: 32,
    avg_weekly_mileage_mi: 30,
    longest_run_mi: 15,
    runs_per_week: 4,
    suggested_days_per_week: 4,
    dominant_long_run_weekday: 0, // Sunday
    road_trail_mix: { road: 0.6, trail: 0.4 },
    ...over,
  };
}

/** A light, casual base (no clear experience signal). */
export function casualSnapshot(over: Partial<StravaFitnessSnapshot> = {}): StravaFitnessSnapshot {
  return {
    window_days: 90,
    activity_count: 24,
    run_count: 20,
    weeks_observed: 10,
    recent_weekly_mileage_mi: 12,
    avg_weekly_mileage_mi: 11,
    longest_run_mi: 5,
    runs_per_week: 3,
    suggested_days_per_week: 3,
    dominant_long_run_weekday: 6, // Saturday
    road_trail_mix: { road: 0.9, trail: 0.1 },
    ...over,
  };
}

/** A frozen `found` race-lookup result. */
export function found(name: string, date: string, distanceMi: number): RaceLookupResult {
  return {
    ok: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    found: { canonical_name: name, date, distance_mi: distanceMi } as any,
  };
}
