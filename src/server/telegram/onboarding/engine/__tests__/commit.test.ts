import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Boundary mocks for the commitSlots refusal test — the refusal must fire before
// ANY write, so every write surface is a spy that should stay untouched.
const dbFrom = vi.hoisted(() => vi.fn());
const writeHelpers = vi.hoisted(() => ({
  upsertTrainingProfile: vi.fn().mockResolvedValue(undefined),
  upsertProfileSection: vi.fn().mockResolvedValue(undefined),
  upsertMemorySection: vi.fn().mockResolvedValue(undefined),
  seedKnownGapsFromFilled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/db', () => ({ supabaseAdmin: () => ({ from: dbFrom }) }));
vi.mock('../../athlete-training-profile', () => ({
  upsertTrainingProfile: writeHelpers.upsertTrainingProfile,
}));
vi.mock('../../memory', () => ({
  upsertProfileSection: writeHelpers.upsertProfileSection,
  upsertMemorySection: writeHelpers.upsertMemorySection,
}));
vi.mock('../../known-gaps-memory', () => ({
  seedKnownGapsFromFilled: writeHelpers.seedKnownGapsFromFilled,
}));

import { buildGoalWrite, commitSlots, mapInjuryStatus } from '../commit';
import { enforceGuardrails } from '../guardrails';
import { initialV3State, type V3OnboardingState } from '../../slots/slot-state';
import type { SlotState } from '../../slots/schema';
import type { SlotValue, Provenance } from '../../slots/provenance';

// Pin the clock so the future fixture dates never rot into the past-date guard.
beforeAll(() => vi.useFakeTimers({ now: new Date('2026-06-10T12:00:00-07:00'), toFake: ['Date'] }));
afterAll(() => vi.useRealTimers());
beforeEach(() => vi.clearAllMocks());

function sv<const T>(value: T, provenance: Provenance = 'stated'): SlotValue<T> {
  return { value, provenance, confirmed: true };
}

function state(slots: SlotState): V3OnboardingState {
  return { ...initialV3State(null), phase: 'recap', slots };
}

const trainingBase: SlotState = {
  experience_tier: sv('some_training'),
  days_per_week: sv(4),
  long_run_day: sv(0),
};

describe('buildGoalWrite', () => {
  it('maps general fitness to day_to_day + keep_fit with no race', () => {
    const { profile, race } = buildGoalWrite(
      state({ ...trainingBase, goal_type: sv('general_fitness') }),
    );
    expect(profile.goal_type).toBe('day_to_day');
    expect(profile.goal_state).toBe('day_to_day');
    expect(profile.goal_distance).toBe('keep_fit');
    expect(profile.target_date).toBeNull();
    expect(race).toBeNull();
    expect(profile.experience_tier).toBe('some_training');
  });

  it('builds a committed race write with the race row', () => {
    const { profile, race } = buildGoalWrite(
      state({
        ...trainingBase,
        goal_type: sv('race'),
        goal_distance: sv('marathon'),
        goal_race: sv('CIM'),
        goal_date: sv('2026-12-06'),
        target_time: sv(15900),
      }),
    );
    expect(profile.goal_state).toBe('committed');
    expect(profile.goal_distance).toBe('marathon');
    expect(profile.target_date).toBe('2026-12-06');
    expect(race).not.toBeNull();
    expect(race!.name).toBe('CIM');
    expect(race!.date).toBe('2026-12-06');
    expect(race!.target_type).toBe('time');
    expect(race!.target_time_sec).toBe(15900);
    expect(race!.distance_mi).toBeCloseTo(26.2, 1);
  });

  it('marks a race "finish" when no target time is set', () => {
    const { race } = buildGoalWrite(
      state({
        ...trainingBase,
        goal_type: sv('race'),
        goal_distance: sv('half'),
        goal_race: sv('Local Half'),
        goal_date: sv('2026-09-01'),
      }),
    );
    expect(race!.target_type).toBe('finish');
    expect(race!.target_time_sec).toBeNull();
  });

  it('builds an intended write (distance, no race row) when no race is named', () => {
    const { profile, race } = buildGoalWrite(
      state({ ...trainingBase, goal_type: sv('race'), goal_distance: sv('marathon') }),
    );
    expect(profile.goal_state).toBe('intended');
    expect(profile.goal_distance).toBe('marathon');
    expect(race).toBeNull();
  });

  it('carries the real distance onto the race row for an accepted pocket (V3-W8)', () => {
    const { profile, race } = buildGoalWrite({
      ...state({
        ...trainingBase,
        goal_type: sv('race'),
        goal_distance: sv('marathon'), // the proxy bucket the plan is built toward
        goal_race: sv('Western States 100'),
        goal_date: sv('2026-06-27'),
      }),
      out_of_catalog: {
        words: 'Western States 100',
        distance_mi: 100,
        proxy: 'marathon',
        consent: 'accepted',
      },
    });
    expect(profile.goal_distance).toBe('marathon'); // proxy still drives selection
    expect(race!.distance_mi).toBe(100); // but the row tells the truth
  });

  it('rides target_time and the real distance together for a short pocket (R1 fixes 1 + 5)', () => {
    const { profile, race } = buildGoalWrite({
      ...state({
        ...trainingBase,
        goal_type: sv('race'),
        goal_distance: sv('5k'), // the short-side proxy
        goal_race: sv('Main Street Mile'),
        goal_date: sv('2026-09-12'),
        target_time: sv(300), // sub-5 — must reach the race row
      }),
      out_of_catalog: {
        words: 'a sub-5 mile',
        distance_mi: 1,
        proxy: '5k',
        consent: 'accepted',
      },
    });
    expect(profile.goal_distance).toBe('5k');
    expect(race!.distance_mi).toBe(1); // the real distance, not the 5k nominal
    expect(race!.target_type).toBe('time');
    expect(race!.target_time_sec).toBe(300);
  });
});

describe('mapInjuryStatus', () => {
  it('maps slot status to the injuries enum (past → resolved)', () => {
    expect(mapInjuryStatus('past')).toBe('resolved');
    expect(mapInjuryStatus('active')).toBe('active');
    expect(mapInjuryStatus('monitoring')).toBe('monitoring');
  });
});

describe('commitSlots — past target_date refusal (R1 fix 3 / T-9)', () => {
  it('throws PAST_TARGET_DATE for a committed race dated in the past, before any write', async () => {
    const s = state({
      ...trainingBase,
      goal_type: sv('race'),
      goal_distance: sv('5k'),
      goal_race: sv('Some Race'),
      goal_date: sv('2025-09-01'), // the Nathan date
    });
    await expect(commitSlots('ath-1', s)).rejects.toMatchObject({ code: 'PAST_TARGET_DATE' });
    expect(dbFrom).not.toHaveBeenCalled();
    expect(writeHelpers.upsertTrainingProfile).not.toHaveBeenCalled();
    expect(writeHelpers.upsertProfileSection).not.toHaveBeenCalled();
    expect(writeHelpers.seedKnownGapsFromFilled).not.toHaveBeenCalled();
  });

  it('refuses an intended-state past target_date too (no race row, profile date only)', async () => {
    const s = state({
      ...trainingBase,
      goal_type: sv('race'),
      goal_distance: sv('marathon'),
      goal_date: sv('2025-09-01'), // no race name → intended branch
    });
    await expect(commitSlots('ath-1', s)).rejects.toMatchObject({ code: 'PAST_TARGET_DATE' });
    expect(dbFrom).not.toHaveBeenCalled();
  });
});

describe('commitSlots — the "Also working toward" profile section (R2)', () => {
  // An intended goal (no race row, future-safe) keeps the DB surface to the
  // mocked helpers, so the section write is the only thing under test.
  function intendedState(over: Partial<V3OnboardingState> = {}): V3OnboardingState {
    return {
      ...state({
        ...trainingBase,
        goal_type: sv('race'),
        goal_distance: sv('marathon'),
        injury_status: sv('none'),
      }),
      ...over,
    };
  }

  it('writes the section from intents, one bullet per clause', async () => {
    await commitSlots(
      'ath-1',
      intendedState({ intents: ['speed at shorter distances', 'build muscle strength'] }),
    );
    expect(writeHelpers.upsertProfileSection).toHaveBeenCalledWith(
      'ath-1',
      'Also working toward',
      '- speed at shorter distances\n- build muscle strength',
    );
  });

  it('skips the section when there are no intents', async () => {
    await commitSlots('ath-1', intendedState());
    const sections = writeHelpers.upsertProfileSection.mock.calls.map((c) => c[1]);
    expect(sections).not.toContain('Also working toward');
  });
});

describe('commitSlots — a superseded pocket leaves no trace (stale-pocket fix)', () => {
  // The full pipeline for the flagged bug: an ACCEPTED 44-mi pocket, then a
  // pivot to a real marathon. The engine (enforceGuardrails) clears the pocket;
  // this asserts the commit consequences — the race row carries the bucket
  // nominal (not 44), no North-star section is written, and the old goal rides
  // in "Also working toward".
  it('writes the bucket nominal and no North-star section after the pivot', async () => {
    const raceInsert = vi.fn((_row: { distance_mi: number; name: string }) => ({
      select: () => ({ single: async () => ({ data: { id: 'race-1' } }) }),
    }));
    dbFrom.mockImplementation((table: string) => ({
      insert: table === 'races' ? raceInsert : vi.fn(async () => ({ error: null })),
      upsert: vi.fn(async () => ({})),
      update: vi.fn(() => ({ eq: async () => ({}) })),
    }));

    const accepted: V3OnboardingState = {
      ...state({
        ...trainingBase,
        goal_type: sv('race'),
        goal_distance: sv('marathon'), // the accepted proxy
        injury_status: sv('none'),
      }),
      out_of_catalog: {
        words: '44 miles in the mountains',
        distance_mi: 44,
        proxy: 'marathon',
        consent: 'accepted',
      },
    };
    const pivoted = enforceGuardrails(accepted, {
      fills: [
        { slot: 'goal_race', value: 'CIM', provenance: 'stated' },
        { slot: 'goal_date', value: '2026-12-06', provenance: 'stated' },
        { slot: 'goal_distance', value: 'marathon', provenance: 'stated' },
      ],
      next_action: 'ask',
      message: '',
      chips: [],
      asked_slot: null,
      race_lookup_query: null,
      goal_distance_mi: null,
      contradiction: null,
      numeric_unresolved: null,
      intents: [],
      reflection: null,
      volume_goal: null,
    }).state;

    await commitSlots('ath-1', pivoted);

    expect(raceInsert).toHaveBeenCalledOnce();
    const row = raceInsert.mock.calls[0]![0];
    expect(row.name).toBe('CIM');
    expect(row.distance_mi).toBeCloseTo(26.2, 1); // the nominal, not the stale 44
    const sections = writeHelpers.upsertProfileSection.mock.calls.map((c) => c[1]);
    expect(sections).not.toContain('North-star goal');
    expect(writeHelpers.upsertProfileSection).toHaveBeenCalledWith(
      'ath-1',
      'Also working toward',
      '- 44 miles in the mountains',
    );
  });
});
