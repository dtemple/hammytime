import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/strava/activities', () => ({ getFitnessSnapshot: vi.fn() }));
vi.mock('../athlete-training-profile', () => ({ getTrainingProfile: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import { getFitnessSnapshot, type StravaFitnessSnapshot } from '@/server/strava/activities';
import { getTrainingProfile } from '../athlete-training-profile';
import { selectPlan, renderPlan, DRAFT_SAFETY_CAPS } from '@/lib/plan-templates';
import type { SelectorProfile } from '@/lib/plan-templates';
import {
  toFitnessSnapshotInput,
  todayInTz,
  buildSelectorProfile,
  generateAndPersistPlan,
  supersedeActiveTemplatePlan,
} from '../plan-gen';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const SNAPSHOT: StravaFitnessSnapshot = {
  window_days: 56,
  activity_count: 40,
  run_count: 36,
  weeks_observed: 8,
  recent_weekly_mileage_mi: 34,
  avg_weekly_mileage_mi: 30,
  longest_run_mi: 14,
  runs_per_week: 4.5,
  suggested_days_per_week: 5,
  dominant_long_run_weekday: 0,
  road_trail_mix: { road: 0.9, trail: 0.1 },
};

const COMMITTED_PROFILE = {
  athlete_id: 'athlete-1',
  goal_type: 'race',
  goal_state: 'committed',
  experience_tier: 'experienced',
  goal_distance: 'marathon',
  days_per_week: 5,
  long_run_day: 0,
  target_date: '2026-12-06',
  goal_race_id: 'race-1',
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

const CIM_RACE = {
  name: 'CIM',
  date: '2026-12-06',
  distance_mi: 26.2,
  elevation_ft: 300,
  terrain: 'road',
  target_type: 'finish',
  target_time_sec: null,
};

type DbState = {
  timezone?: string;
  raceRow?: Record<string, unknown> | null;
  injuries?: { body_part: string }[];
  existingPlanRow?: { id: string; current_version_id: string | null } | null;
  existingVersionRow?: Record<string, unknown> | null;
};

function makeDb(state: DbState = {}) {
  const plansInsert = vi.fn(() => ({
    select: () => ({ single: async () => ({ data: { id: 'plan-1' }, error: null }) }),
  }));
  const versionsInsert = vi.fn(() => ({
    select: () => ({ single: async () => ({ data: { id: 'ver-1' }, error: null }) }),
  }));
  const plansUpdate = vi.fn(() => ({ eq: async () => ({ error: null }) }));
  const versionsUpdate = vi.fn(() => ({ eq: async () => ({ error: null }) }));

  const from = vi.fn((table: string) => {
    if (table === 'athletes') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { timezone: state.timezone ?? 'America/Los_Angeles' },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'races') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.raceRow ?? null, error: null }) }),
        }),
      };
    }
    if (table === 'injuries') {
      return {
        select: () => ({ eq: async () => ({ data: state.injuries ?? [], error: null }) }),
      };
    }
    if (table === 'plans') {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: state.existingPlanRow ?? null, error: null }),
              }),
            }),
          }),
        }),
        insert: plansInsert,
        update: plansUpdate,
      };
    }
    if (table === 'plan_versions') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.existingVersionRow ?? null, error: null }) }),
        }),
        insert: versionsInsert,
        update: versionsUpdate,
      };
    }
    return {};
  });

  return { supa: { from }, plansInsert, versionsInsert, plansUpdate, versionsUpdate };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getFitnessSnapshot as AnyMock).mockResolvedValue(SNAPSHOT);
  (getTrainingProfile as AnyMock).mockResolvedValue(COMMITTED_PROFILE);
});

// ---------------------------------------------------------------------------
// toFitnessSnapshotInput
// ---------------------------------------------------------------------------

describe('toFitnessSnapshotInput', () => {
  it('maps every snake_case field to camelCase', () => {
    expect(toFitnessSnapshotInput(SNAPSHOT)).toEqual({
      recentWeeklyMileageMi: 34,
      avgWeeklyMileageMi: 30,
      longestRunMi: 14,
      runsPerWeek: 4.5,
      suggestedDaysPerWeek: 5,
      dominantLongRunWeekday: 0,
      roadTrailMix: { road: 0.9, trail: 0.1 },
    });
  });

  it('passes null through (no Strava connection)', () => {
    expect(toFitnessSnapshotInput(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// todayInTz
// ---------------------------------------------------------------------------

describe('todayInTz', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the athlete-local calendar date across a tz boundary', () => {
    vi.useFakeTimers();
    // 05:00 UTC = 22:00 the previous day in Pacific.
    vi.setSystemTime(new Date('2026-06-02T05:00:00Z'));
    expect(todayInTz('America/Los_Angeles')).toBe('2026-06-01');
    expect(todayInTz('UTC')).toBe('2026-06-02');
  });
});

// ---------------------------------------------------------------------------
// buildSelectorProfile
// ---------------------------------------------------------------------------

describe('buildSelectorProfile', () => {
  it('maps a committed race profile (race row → distance/date/terrain/target)', async () => {
    const { supa } = makeDb({ raceRow: CIM_RACE, injuries: [{ body_part: 'left knee' }] });
    (supabaseAdmin as AnyMock).mockReturnValue(supa);

    const profile = await buildSelectorProfile('athlete-1', '2026-06-02');

    expect(profile).toMatchObject({
      experienceTier: 'experienced',
      goalDistance: 'marathon',
      daysPerWeek: 5,
      longRunDay: 0,
      goalState: 'committed',
      targetDate: '2026-12-06',
      targetType: 'finish',
      targetTimeSec: null,
      today: '2026-06-02',
      injuries: [{ bodyPart: 'left knee' }],
    });
    expect(profile.race).toEqual({
      name: 'CIM',
      date: '2026-12-06',
      distanceMiles: 26.2,
      elevationGainFt: 300,
      type: 'road',
    });
  });

  it('leaves race null for an intended-no-race profile', async () => {
    (getTrainingProfile as AnyMock).mockResolvedValue({
      ...COMMITTED_PROFILE,
      goal_state: 'intended',
      goal_distance: 'half',
      goal_race_id: null,
      target_date: '2026-09-01',
    });
    const { supa } = makeDb({ injuries: [] });
    (supabaseAdmin as AnyMock).mockReturnValue(supa);

    const profile = await buildSelectorProfile('athlete-1', '2026-06-02');

    expect(profile.race).toBeNull();
    expect(profile.goalState).toBe('intended');
    expect(profile.goalDistance).toBe('half');
    expect(profile.injuries).toEqual([]);
  });

  it('throws when the training profile is missing tier/distance', async () => {
    (getTrainingProfile as AnyMock).mockResolvedValue({
      ...COMMITTED_PROFILE,
      experience_tier: null,
      goal_distance: null,
    });
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb().supa);

    await expect(buildSelectorProfile('athlete-1', '2026-06-02')).rejects.toThrow(/incomplete/);
  });
});

// ---------------------------------------------------------------------------
// generateAndPersistPlan
// ---------------------------------------------------------------------------

describe('generateAndPersistPlan', () => {
  it('persists a template version and sets BOTH baseline and current pointers', async () => {
    const { supa, plansInsert, versionsInsert, plansUpdate } = makeDb({
      raceRow: CIM_RACE,
      injuries: [],
      existingPlanRow: null,
    });
    (supabaseAdmin as AnyMock).mockReturnValue(supa);

    const result = await generateAndPersistPlan('athlete-1');

    expect(plansInsert).toHaveBeenCalledWith(
      expect.objectContaining({ athlete_id: 'athlete-1', goal_race_id: 'race-1' }),
    );
    expect(versionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_id: 'plan-1',
        version: 1,
        generated_by: 'template',
        status: 'active',
      }),
    );
    expect(plansUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ current_version_id: 'ver-1', baseline_version_id: 'ver-1' }),
    );
    expect(result.planId).toBe('plan-1');
    expect(result.versionId).toBe('ver-1');
    expect(result.plan.metadata.plan_structure.total_weeks).toBeGreaterThan(0);
  });

  it('is idempotent: reuses an existing active template plan instead of inserting', async () => {
    // Build a real rendered plan to stand in as the already-persisted JSON.
    const seedProfile: SelectorProfile = {
      experienceTier: 'experienced',
      goalDistance: 'marathon',
      daysPerWeek: 5,
      longRunDay: 0,
      goalState: 'committed',
      targetDate: '2026-12-06',
      targetType: 'finish',
      targetTimeSec: null,
      race: { name: 'CIM', date: '2026-12-06', distanceMiles: 26.2, type: 'road' },
      injuries: [],
      today: '2026-06-02',
    };
    const { template, params } = selectPlan(seedProfile, null, DRAFT_SAFETY_CAPS);
    const storedPlan = renderPlan(template, params);

    const { supa, plansInsert, versionsInsert } = makeDb({
      raceRow: CIM_RACE,
      injuries: [],
      existingPlanRow: { id: 'plan-9', current_version_id: 'ver-9' },
      existingVersionRow: {
        id: 'ver-9',
        plan_json: storedPlan,
        generated_by: 'template',
        status: 'active',
      },
    });
    (supabaseAdmin as AnyMock).mockReturnValue(supa);

    const result = await generateAndPersistPlan('athlete-1');

    expect(plansInsert).not.toHaveBeenCalled();
    expect(versionsInsert).not.toHaveBeenCalled();
    expect(result.planId).toBe('plan-9');
    expect(result.versionId).toBe('ver-9');
  });

  // V4-W3b make-or-break: once the old plan is superseded (current_version_id
  // nulled), the idempotency guard must yield so a FRESH plan generates for the
  // new event — not the stale one.
  it('generates a fresh plan once the prior version is superseded (current_version_id null)', async () => {
    const { supa, plansInsert, versionsInsert } = makeDb({
      raceRow: CIM_RACE,
      injuries: [],
      existingPlanRow: { id: 'plan-9', current_version_id: null },
    });
    (supabaseAdmin as AnyMock).mockReturnValue(supa);

    const result = await generateAndPersistPlan('athlete-1');

    expect(plansInsert).toHaveBeenCalledOnce();
    expect(versionsInsert).toHaveBeenCalledOnce();
    expect(result.planId).toBe('plan-1');
    expect(result.versionId).toBe('ver-1');
  });
});

// ---------------------------------------------------------------------------
// supersedeActiveTemplatePlan (V4-W3b)
// ---------------------------------------------------------------------------

describe('supersedeActiveTemplatePlan', () => {
  it('supersedes the active version, nulls current_version_id, and returns true', async () => {
    const { supa, versionsUpdate, plansUpdate } = makeDb({
      existingPlanRow: { id: 'plan-9', current_version_id: 'ver-9' },
    });
    (supabaseAdmin as AnyMock).mockReturnValue(supa);

    const retired = await supersedeActiveTemplatePlan('athlete-1');

    expect(retired).toBe(true);
    expect(versionsUpdate).toHaveBeenCalledWith({ status: 'superseded' });
    expect(plansUpdate).toHaveBeenCalledWith({ current_version_id: null });
  });

  it('is a no-op (returns false) when the athlete has no active plan', async () => {
    const { supa, versionsUpdate, plansUpdate } = makeDb({
      existingPlanRow: { id: 'plan-9', current_version_id: null },
    });
    (supabaseAdmin as AnyMock).mockReturnValue(supa);

    const retired = await supersedeActiveTemplatePlan('athlete-1');

    expect(retired).toBe(false);
    expect(versionsUpdate).not.toHaveBeenCalled();
    expect(plansUpdate).not.toHaveBeenCalled();
  });
});
