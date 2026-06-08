import { describe, it, expect } from 'vitest';
import {
  selectTemplateId,
  timeGoalEligibility,
  computeRenderParams,
  DRAFT_SAFETY_CAPS,
  getTemplate,
} from '../index';
import type { ExperienceTier, GoalDistance, TemplateId } from '../types';
import type { FitnessSnapshotInput, SelectorProfile } from '../selector';

const TIERS: ExperienceTier[] = ['beginner', 'for_fun', 'some_training', 'experienced'];

const SNAP: FitnessSnapshotInput = {
  recentWeeklyMileageMi: 28,
  avgWeeklyMileageMi: 26,
  longestRunMi: 10,
  runsPerWeek: 4,
  suggestedDaysPerWeek: 4,
  dominantLongRunWeekday: 0,
  roadTrailMix: { road: 0.85, trail: 0.15 },
};

function profile(overrides: Partial<SelectorProfile> = {}): SelectorProfile {
  return {
    experienceTier: 'some_training',
    goalDistance: 'marathon',
    daysPerWeek: 4,
    longRunDay: 0,
    goalState: 'committed',
    targetDate: '2026-10-04',
    targetType: 'finish',
    targetTimeSec: null,
    race: { name: 'Test Marathon', date: '2026-10-04', distanceMiles: 26.2, type: 'road' },
    injuries: [],
    today: '2026-06-08',
    ...overrides,
  };
}

describe('selectTemplateId — the (distance × tier) table', () => {
  const expectations: Record<GoalDistance, Record<ExperienceTier, TemplateId>> = {
    '5k': {
      beginner: 'short-race',
      for_fun: 'short-race',
      some_training: 'short-race',
      experienced: 'short-race',
    },
    '10k': {
      beginner: 'short-race',
      for_fun: 'short-race',
      some_training: 'short-race',
      experienced: 'short-race',
    },
    half: {
      beginner: 'half-foundation',
      for_fun: 'half-foundation',
      some_training: 'half-development',
      experienced: 'half-development',
    },
    marathon: {
      beginner: 'marathon-finish',
      for_fun: 'marathon-finish',
      some_training: 'marathon-finish',
      experienced: 'marathon-performance',
    },
    keep_fit: {
      beginner: 'base-maintenance',
      for_fun: 'base-maintenance',
      some_training: 'base-maintenance',
      experienced: 'base-maintenance',
    },
  };

  for (const distance of Object.keys(expectations) as GoalDistance[]) {
    for (const tier of TIERS) {
      it(`${distance} × ${tier} → ${expectations[distance][tier]}`, () => {
        const id = selectTemplateId(distance, tier);
        expect(id).toBe(expectations[distance][tier]);
        // every selected template is authored and serves the distance
        const t = getTemplate(id);
        expect(t.distances).toContain(distance);
        expect(t.appliesToTiers).toContain(tier);
      });
    }
  }
});

describe('timeGoalEligibility — gated harder than other overlays', () => {
  it('opens on performance / development / short-race', () => {
    expect(timeGoalEligibility('marathon-performance', 'experienced')).toEqual({
      eligible: true,
      discouraged: false,
    });
    expect(timeGoalEligibility('half-development', 'some_training')).toEqual({
      eligible: true,
      discouraged: false,
    });
    expect(timeGoalEligibility('short-race', 'beginner')).toEqual({
      eligible: true,
      discouraged: false,
    });
  });

  it('permits-but-discourages a some_training first marathon', () => {
    expect(timeGoalEligibility('marathon-finish', 'some_training')).toEqual({
      eligible: true,
      discouraged: true,
    });
  });

  it('suppresses on a beginner/for_fun marathon-finish, half-foundation, base-maintenance', () => {
    expect(timeGoalEligibility('marathon-finish', 'beginner').eligible).toBe(false);
    expect(timeGoalEligibility('half-foundation', 'for_fun').eligible).toBe(false);
    expect(timeGoalEligibility('base-maintenance', 'experienced').eligible).toBe(false);
  });
});

describe('computeRenderParams — timeline across the three goal states', () => {
  it('committed → a concrete week count between today and the race', () => {
    const t = getTemplate('marathon-finish');
    const p = computeRenderParams(
      profile({ goalState: 'committed', targetDate: '2026-10-04', today: '2026-06-08' }),
      SNAP,
      DRAFT_SAFETY_CAPS,
      t,
    );
    // 2026-06-08 (Mon) → race 2026-10-04 (Sun). mondayOf both: 2026-06-08 → 2026-09-28
    // is 16 weeks; the count is INCLUSIVE of today's week through the race week, so 17.
    expect(p.totalWeeks).toBe(17);
    expect(p.race).not.toBeNull();
  });

  it('intended-with-date → a concrete week count, no committed race', () => {
    const t = getTemplate('marathon-finish');
    const p = computeRenderParams(
      profile({ goalState: 'intended', targetDate: '2026-09-01', race: null, today: '2026-06-08' }),
      SNAP,
      DRAFT_SAFETY_CAPS,
      t,
    );
    expect(p.totalWeeks).toBeGreaterThan(0);
    expect(p.race).toBeNull();
  });

  it('intended-no-date → open-ended (null weeks) with the open_ended overlay', () => {
    const t = getTemplate('marathon-finish');
    const p = computeRenderParams(
      profile({ goalState: 'intended', targetDate: null, race: null }),
      SNAP,
      DRAFT_SAFETY_CAPS,
      t,
    );
    expect(p.totalWeeks).toBeNull();
    expect(p.overlays).toContain('open_ended');
  });

  it('keep_fit is open-ended even if a date is present', () => {
    const t = getTemplate('base-maintenance');
    const p = computeRenderParams(
      profile({
        goalDistance: 'keep_fit',
        goalState: 'day_to_day',
        targetDate: '2026-09-01',
        race: null,
        experienceTier: 'experienced',
      }),
      SNAP,
      DRAFT_SAFETY_CAPS,
      t,
    );
    expect(p.totalWeeks).toBeNull();
  });
});

describe('computeRenderParams — volume, run days, overlays', () => {
  it('floors start volume to the template minimum and bounds the peak', () => {
    const t = getTemplate('marathon-performance');
    const p = computeRenderParams(
      profile({
        experienceTier: 'experienced',
        goalState: 'committed',
      }),
      { ...SNAP, recentWeeklyMileageMi: 5 },
      DRAFT_SAFETY_CAPS,
      t,
    );
    expect(p.startVolumeMi).toBeGreaterThanOrEqual(t.volume.startVolumeFloorMi);
    expect(p.peakVolumeMi).toBeLessThanOrEqual(t.volume.peakVolumeCapMi);
    expect(p.peakVolumeMi).toBeLessThanOrEqual(p.startVolumeMi * t.volume.peakMultiplierMax + 0.5);
  });

  it('clamps run days into the template’s supported microcycle range', () => {
    const t = getTemplate('marathon-finish'); // supports 3–5
    const p = computeRenderParams(profile({ daysPerWeek: 7 }), SNAP, DRAFT_SAFETY_CAPS, t);
    expect(p.runsPerWeek).toBe(5);
    const p2 = computeRenderParams(profile({ daysPerWeek: 1 }), SNAP, DRAFT_SAFETY_CAPS, t);
    expect(p2.runsPerWeek).toBe(3);
  });

  it('clamps the long run to the lesser of the template and per-distance cap', () => {
    const t = getTemplate('short-race');
    const p = computeRenderParams(
      profile({
        goalDistance: '5k',
        experienceTier: 'for_fun',
        race: { name: 'x', date: '2026-10-04', distanceMiles: 3.1, type: 'road' },
      }),
      { ...SNAP, longestRunMi: 30 },
      DRAFT_SAFETY_CAPS,
      t,
    );
    expect(p.longRunCapMi).toBe(DRAFT_SAFETY_CAPS.maxLongRunMiByDistance['5k']);
    expect(p.startLongRunMi).toBeLessThanOrEqual(p.longRunCapMi);
  });

  it('adds the time_goal overlay only when eligible; sets discouraged correctly', () => {
    const perf = getTemplate('marathon-performance');
    const pPerf = computeRenderParams(
      profile({ experienceTier: 'experienced', targetType: 'time', targetTimeSec: 3 * 3600 }),
      SNAP,
      DRAFT_SAFETY_CAPS,
      perf,
    );
    expect(pPerf.overlays).toContain('time_goal');
    expect(pPerf.timeGoalDiscouraged).toBe(false);

    const finish = getTemplate('marathon-finish');
    const pFinish = computeRenderParams(
      profile({ experienceTier: 'some_training', targetType: 'time', targetTimeSec: 4 * 3600 }),
      SNAP,
      DRAFT_SAFETY_CAPS,
      finish,
    );
    expect(pFinish.overlays).toContain('time_goal');
    expect(pFinish.timeGoalDiscouraged).toBe(true);

    const foundation = getTemplate('half-foundation');
    const pFound = computeRenderParams(
      profile({
        goalDistance: 'half',
        experienceTier: 'beginner',
        targetType: 'time',
        targetTimeSec: 2 * 3600,
      }),
      SNAP,
      DRAFT_SAFETY_CAPS,
      foundation,
    );
    expect(pFound.overlays).not.toContain('time_goal');
  });

  it('adds the trail overlay when the snapshot leans trail', () => {
    const t = getTemplate('marathon-finish');
    const p = computeRenderParams(
      profile(),
      { ...SNAP, roadTrailMix: { road: 0.2, trail: 0.8 } },
      DRAFT_SAFETY_CAPS,
      t,
    );
    expect(p.overlays).toContain('trail');
  });

  it('adds the injury overlay and records open known gaps', () => {
    const t = getTemplate('marathon-finish');
    const p = computeRenderParams(
      profile({ injuries: [{ bodyPart: 'achilles' }] }),
      SNAP,
      DRAFT_SAFETY_CAPS,
      t,
    );
    expect(p.overlays).toContain('injury');
    expect(p.openKnownGaps).toContain('strength_equipment');
    expect(p.strengthEquipment).toBe('unknown');
  });
});
