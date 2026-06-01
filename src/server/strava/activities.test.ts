import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/crypto', () => ({
  decryptToken: vi.fn(async () => 'access-token'),
  encryptToken: vi.fn(async () => 'enc'),
}));
vi.mock('./client', () => ({
  refreshAccessToken: vi.fn(async () => ({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  })),
}));

import { supabaseAdmin } from '@/lib/db';
import {
  getLoggedInAthlete,
  getFitnessSnapshot,
  deriveTimezone,
  StravaTokenBrokenError,
  type StravaActivitySummary,
} from './activities';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-1';
const FUTURE = '2026-06-02T12:00:00Z';

// A chainable supabase mock: maybeSingle() resolves to { data: row }, and an
// awaited update().eq().eq() resolves to { data: null, error: null }.
function makeDb(row: unknown) {
  const result = { data: row, error: null };
  const chain: AnyMock = {
    select: () => chain,
    eq: () => chain,
    update: () => chain,
    maybeSingle: () => Promise.resolve(result),
    then: (onF: AnyMock, onR: AnyMock) =>
      Promise.resolve({ data: null, error: null }).then(onF, onR),
  };
  return { from: () => chain };
}

const TOKEN_ROW = {
  id: 'tok-1',
  access_token_enc: 'a-enc',
  refresh_token_enc: 'r-enc',
  expires_at: FUTURE,
};

function mockFetch() {
  const fn = vi.fn();
  global.fetch = fn as AnyMock;
  return fn;
}

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
  (supabaseAdmin as AnyMock).mockReturnValue(makeDb(TOKEN_ROW));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// getLoggedInAthlete
// ---------------------------------------------------------------------------

describe('getLoggedInAthlete', () => {
  it('maps a full profile', async () => {
    const fetchFn = mockFetch();
    fetchFn.mockResolvedValue(
      jsonRes({
        firstname: 'Dave',
        lastname: 'T',
        sex: 'M',
        city: 'Mill Valley',
        state: 'CA',
        country: 'United States',
        weight: 70.5,
        measurement_preference: 'feet',
      }),
    );

    const profile = await getLoggedInAthlete(ATHLETE_ID);

    expect(profile).toEqual({
      firstname: 'Dave',
      lastname: 'T',
      sex: 'M',
      city: 'Mill Valley',
      state: 'CA',
      country: 'United States',
      weight_kg: 70.5,
      measurement_preference: 'feet',
    });
  });

  it('nulls privacy-hidden fields instead of throwing', async () => {
    const fetchFn = mockFetch();
    fetchFn.mockResolvedValue(jsonRes({ firstname: 'Dave' }));

    const profile = await getLoggedInAthlete(ATHLETE_ID);

    expect(profile).toEqual({
      firstname: 'Dave',
      lastname: null,
      sex: null,
      city: null,
      state: null,
      country: null,
      weight_kg: null,
      measurement_preference: null,
    });
  });

  it('returns null when there is no Strava connection', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb(null));
    const fetchFn = mockFetch();

    const profile = await getLoggedInAthlete(ATHLETE_ID);

    expect(profile).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws StravaTokenBrokenError when a 401 survives a refresh retry', async () => {
    const fetchFn = mockFetch();
    fetchFn.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });

    await expect(getLoggedInAthlete(ATHLETE_ID)).rejects.toBeInstanceOf(StravaTokenBrokenError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// getFitnessSnapshot
// ---------------------------------------------------------------------------

// Strava-raw activity fixture (field names match the API, not our summary type).
function raw(
  id: number,
  type: string,
  date: string,
  distance: number,
  tz = '(GMT-08:00) America/Los_Angeles',
) {
  return {
    id,
    name: `act${id}`,
    type,
    start_date_local: `${date}T07:00:00Z`,
    timezone: tz,
    distance,
    moving_time: 0,
    elapsed_time: 0,
    total_elevation_gain: 0,
    average_heartrate: null,
    max_heartrate: null,
    average_speed: 0,
  };
}

describe('getFitnessSnapshot', () => {
  it('computes the snapshot from ~8 weeks of activities', async () => {
    const fetchFn = mockFetch();
    fetchFn.mockResolvedValue(
      jsonRes([
        raw(1, 'Run', '2026-05-31', 20000), // Sun, recent, week longest
        raw(2, 'Run', '2026-05-27', 8000), // Wed, recent
        raw(3, 'Run', '2026-05-24', 18000), // Sun, recent, week longest
        raw(4, 'Run', '2026-05-20', 6000), // Wed, recent
        raw(5, 'TrailRun', '2026-05-13', 10000), // Wed, recent, only run that week
        raw(6, 'Run', '2026-05-10', 16000), // Sun, recent, week longest
        raw(7, 'Run', '2026-04-26', 14000), // Sun, NOT recent (>28d), week longest
        raw(8, 'Ride', '2026-05-28', 30000), // not a run — excluded
      ]),
    );

    const snap = await getFitnessSnapshot(ATHLETE_ID);

    expect(snap).toEqual({
      window_days: 56,
      activity_count: 8,
      run_count: 7,
      weeks_observed: 5,
      recent_weekly_mileage_mi: 12.1,
      avg_weekly_mileage_mi: 7.1,
      longest_run_mi: 12.4,
      runs_per_week: 0.9,
      suggested_days_per_week: 3,
      dominant_long_run_weekday: 0, // Sunday
      road_trail_mix: { road: 6, trail: 1 },
    });
  });

  it('returns a zero-count snapshot for a connected athlete with no activities', async () => {
    const fetchFn = mockFetch();
    fetchFn.mockResolvedValue(jsonRes([]));

    const snap = await getFitnessSnapshot(ATHLETE_ID);

    expect(snap).toEqual({
      window_days: 56,
      activity_count: 0,
      run_count: 0,
      weeks_observed: 0,
      recent_weekly_mileage_mi: 0,
      avg_weekly_mileage_mi: 0,
      longest_run_mi: 0,
      runs_per_week: 0,
      suggested_days_per_week: 3,
      dominant_long_run_weekday: null,
      road_trail_mix: { road: 0, trail: 0 },
    });
  });

  it('returns null when there is no Strava connection', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb(null));
    const fetchFn = mockFetch();

    const snap = await getFitnessSnapshot(ATHLETE_ID);

    expect(snap).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deriveTimezone
// ---------------------------------------------------------------------------

function activity(date: string, tz: string): StravaActivitySummary {
  return {
    id: 1,
    name: 'run',
    type: 'Run',
    start_date_local: `${date}T07:00:00Z`,
    timezone: tz,
    distance_m: 5000,
    moving_time_s: 0,
    elapsed_time_s: 0,
    total_elevation_gain_m: 0,
    average_heartrate: null,
    max_heartrate: null,
    average_speed_mps: 0,
  };
}

describe('deriveTimezone', () => {
  it('parses the IANA zone from the most recent activity', async () => {
    const tz = deriveTimezone([
      activity('2026-04-01', '(GMT+09:00) Asia/Tokyo'),
      activity('2026-05-20', '(GMT-08:00) America/Los_Angeles'),
    ]);
    expect(tz).toBe('America/Los_Angeles');
  });

  it('parses a positive-offset zone', async () => {
    const tz = deriveTimezone([activity('2026-05-20', '(GMT+09:00) Asia/Tokyo')]);
    expect(tz).toBe('Asia/Tokyo');
  });

  it('returns null for an empty activity list', async () => {
    expect(deriveTimezone([])).toBeNull();
  });

  it('returns null when no activity carries a parseable timezone', async () => {
    expect(deriveTimezone([activity('2026-05-20', '')])).toBeNull();
  });
});
