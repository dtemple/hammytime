import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { KNOWN_GAPS } from '@/lib/known-gaps';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
import { supabaseAdmin } from '@/lib/db';

import {
  slotValueSchema,
  unknownSlot,
  isFilled,
  type Provenance,
  type SlotValue,
} from '../provenance';
import {
  SLOTS,
  SLOT_KEYS,
  FINISH_TIME_RANGES_SEC,
  requiredCoreSlots,
  safetySlots,
  planDrivingSlots,
  slotsToGaps,
  raceOnlyGapKeys,
  type GoalTypeValue,
  type SlotState,
} from '../schema';
import {
  initialV3State,
  loadV3State,
  saveV3State,
  isV3OnboardingComplete,
  isV3Enabled,
  seedStravaInferences,
  DEFAULT_OPTIONAL_BUDGET,
  V3_SCHEMA_VERSION,
} from '../slot-state';
import type { StravaFitnessSnapshot } from '@/server/strava/activities';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDB = any;

function sv<T>(value: T, provenance: Provenance = 'stated'): SlotValue<T> {
  return { value, provenance, confirmed: true };
}

function coreSlots(goalType: GoalTypeValue): SlotState {
  const base: SlotState = {
    goal_type: sv(goalType),
    experience_tier: sv('some_training'),
    goal_distance: sv(goalType === 'race' ? 'marathon' : 'keep_fit'),
    days_per_week: sv(4),
    long_run_day: sv(0),
  };
  return goalType === 'race' ? { ...base, goal_date: sv('2026-11-01') } : base;
}

function makeState(slots: SlotState) {
  return { ...initialV3State(null), slots };
}

describe('schema invariants', () => {
  it('every required-core slot is confirmed (inline or implicit), never silent', () => {
    for (const key of SLOT_KEYS) {
      if (SLOTS[key].class !== 'required-core') continue;
      expect(['inline', 'implicit']).toContain(SLOTS[key].confirmPolicy);
    }
  });

  it('every safety slot is asked/echoed (gate or inline), never silent', () => {
    for (const key of safetySlots()) {
      expect(['gate', 'inline']).toContain(SLOTS[key].confirmPolicy);
    }
    expect(safetySlots().sort()).toEqual(['injury_detail', 'injury_status']);
  });

  it('every plan-driving slot is confirmed before use (§5.4)', () => {
    for (const key of planDrivingSlots()) {
      expect(['inline', 'implicit']).toContain(SLOTS[key].confirmPolicy);
    }
  });

  it('every slot with a knownGapKey maps to a real KnownGap', () => {
    for (const key of SLOT_KEYS) {
      const gapKey = SLOTS[key].knownGapKey;
      if (!gapKey) continue;
      expect(KNOWN_GAPS[gapKey]).toBeDefined();
    }
  });

  it('every numeric slot carries a sane plausibleRange', () => {
    for (const key of SLOT_KEYS) {
      const num = SLOTS[key].numeric;
      if (!num) continue;
      expect(num.plausibleRange.min).toBeLessThan(num.plausibleRange.max);
    }
  });

  it('every raceOnly slot is a race slot', () => {
    const raceOnly = SLOT_KEYS.filter((k) => SLOTS[k].raceOnly).sort();
    expect(raceOnly).toEqual(['goal_date', 'goal_race', 'target_time', 'tune_up_races']);
  });

  it('keys its own def (no copy/paste key mismatch)', () => {
    for (const key of SLOT_KEYS) expect(SLOTS[key].key).toBe(key);
  });

  it('has distance-keyed finish-time ranges but none for keep_fit', () => {
    expect(FINISH_TIME_RANGES_SEC.marathon).toBeDefined();
    expect(FINISH_TIME_RANGES_SEC.marathon!.min).toBeLessThan(FINISH_TIME_RANGES_SEC.marathon!.max);
    expect(FINISH_TIME_RANGES_SEC.keep_fit).toBeUndefined();
  });
});

describe('provenance primitives', () => {
  it('round-trips a SlotValue through its Zod schema', () => {
    const schema = slotValueSchema(z.number());
    expect(schema.parse({ value: 240, provenance: 'stated', confirmed: true })).toEqual({
      value: 240,
      provenance: 'stated',
      confirmed: true,
    });
    expect(schema.safeParse({ value: 240, provenance: 'stated' }).success).toBe(false); // missing confirmed
    expect(schema.safeParse({ value: null, provenance: 'unknown', confirmed: false }).success).toBe(
      true,
    );
  });

  it('unknownSlot is the unfilled resting state', () => {
    expect(unknownSlot()).toEqual({ value: null, provenance: 'unknown', confirmed: false });
  });

  it('isFilled excludes null and unknown-provenance values', () => {
    expect(isFilled(sv(5))).toBe(true);
    expect(isFilled(sv(5, 'inferred'))).toBe(true);
    expect(isFilled(undefined)).toBe(false);
    expect(isFilled(unknownSlot<number>())).toBe(false);
    expect(isFilled({ value: 5, provenance: 'unknown', confirmed: false })).toBe(false);
  });
});

describe('requiredCoreSlots', () => {
  it('excludes race slots for a general-fitness athlete', () => {
    const req = requiredCoreSlots('general_fitness');
    expect(req).not.toContain('goal_date');
    expect(req).not.toContain('goal_race');
    expect(req).toContain('goal_distance');
  });

  it('requires goal_date (but not goal_race) for a race athlete', () => {
    const req = requiredCoreSlots('race');
    expect(req).toContain('goal_date');
    expect(req).not.toContain('goal_race'); // intended branch defers a specific race
  });

  it('falls back to the base set when goal type is unknown', () => {
    expect(requiredCoreSlots(null)).toEqual([
      'goal_type',
      'experience_tier',
      'goal_distance',
      'days_per_week',
      'long_run_day',
    ]);
  });
});

describe('isV3OnboardingComplete', () => {
  it('completes a keep_fit athlete with no race once core + injury are set', () => {
    const state = makeState({ ...coreSlots('general_fitness'), injury_status: sv('none') });
    expect(isV3OnboardingComplete(state)).toBe(true);
  });

  it('does not complete with a required-core slot open', () => {
    const slots = coreSlots('general_fitness');
    delete slots.days_per_week;
    expect(isV3OnboardingComplete(makeState({ ...slots, injury_status: sv('none') }))).toBe(false);
  });

  it('blocks a race athlete with an open goal_date, allows it filled (without goal_race)', () => {
    const open = coreSlots('race');
    delete open.goal_date;
    expect(isV3OnboardingComplete(makeState({ ...open, injury_status: sv('none') }))).toBe(false);
    expect(
      isV3OnboardingComplete(makeState({ ...coreSlots('race'), injury_status: sv('none') })),
    ).toBe(true);
  });

  it('treats an asked-but-unanswered injury beat as satisfied; un-asked + open is not', () => {
    // Soft-via-open (ONBOARDING_CHIPS §6): a dodge leaves injury_status open, but the
    // beat having been asked satisfies the gate. There is no `unknown` value.
    const asked = makeState(coreSlots('general_fitness'));
    asked.asked = ['injury_status'];
    expect(isV3OnboardingComplete(asked)).toBe(true);
    expect(isV3OnboardingComplete(makeState(coreSlots('general_fitness')))).toBe(false);
  });
});

describe('slotsToGaps', () => {
  it('projects only stated optional slots onto known gaps', () => {
    const slots: SlotState = {
      age: sv(34),
      target_time: { value: 12600, provenance: 'inferred', confirmed: false },
      schedule_constraints: sv('runs before work'),
      tune_up_races: sv([{ name: 'Turkey Trot', date: '2026-11-26' }]),
      motivation: sv('first marathon'),
    };
    const gaps = slotsToGaps(slots);
    expect(gaps.age).toBe('34');
    expect(gaps.schedule_constraints).toBe('runs before work');
    expect(gaps.tune_up_races).toBe('Turkey Trot (2026-11-26)');
    expect(gaps.target_time).toBeUndefined(); // inferred, not stated
    expect(Object.keys(gaps)).not.toContain('motivation'); // no knownGapKey
  });

  it('formats a stated target_time finish goal', () => {
    expect(slotsToGaps({ target_time: sv(15900) }).target_time).toBe('4:25:00');
  });
});

describe('raceOnlyGapKeys (V3-W7)', () => {
  it('returns exactly the race-only gaps that have a known-gap key', () => {
    // goal_race / goal_date are raceOnly but carry no knownGapKey, so they're excluded.
    expect(raceOnlyGapKeys()).toEqual(new Set(['target_time', 'tune_up_races']));
  });

  it('stays in sync with the slot schema raceOnly flags', () => {
    const expected = new Set(
      SLOT_KEYS.filter((k) => SLOTS[k].raceOnly && SLOTS[k].knownGapKey).map(
        (k) => SLOTS[k].knownGapKey,
      ),
    );
    expect(raceOnlyGapKeys()).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function makeLoadMock(selectResult: unknown) {
  const single = vi.fn().mockResolvedValue(selectResult);
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  return { from: vi.fn().mockReturnValue({ select }), rpc: vi.fn() };
}

function makeRpcMock(error: unknown = null) {
  return { from: vi.fn(), rpc: vi.fn().mockResolvedValue({ error }) };
}

beforeEach(() => vi.clearAllMocks());

describe('loadV3State', () => {
  it('returns a v3 state when flow is v3 and the schema version matches', async () => {
    const state = initialV3State(null);
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeLoadMock({ data: { onboarding_state: state }, error: null }) as AnyDB,
    );
    expect(await loadV3State('a1')).toEqual(state);
  });

  it('returns null for a v2-shaped state (no flow key)', async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeLoadMock({
        data: { onboarding_state: { step: 1, question: 0, partial: {} } },
        error: null,
      }) as AnyDB,
    );
    expect(await loadV3State('a1')).toBeNull();
  });

  it('returns null on a DB error', async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeLoadMock({ data: null, error: { message: 'fail' } }) as AnyDB,
    );
    expect(await loadV3State('a1')).toBeNull();
  });

  it('resets cleanly on a schema_version mismatch, preserving the cached snapshot', async () => {
    const snapshot = { window_days: 56, activity_count: 10 } as never;
    const stale = {
      ...initialV3State(snapshot),
      schema_version: V3_SCHEMA_VERSION + 1,
      phase: 'intake' as const,
    };
    vi.mocked(supabaseAdmin).mockReturnValue(
      makeLoadMock({ data: { onboarding_state: stale }, error: null }) as AnyDB,
    );
    const loaded = await loadV3State('a1');
    expect(loaded).toEqual(initialV3State(snapshot));
    expect(loaded!.phase).toBe('orientation'); // reset, not the stale 'intake'
    expect(loaded!.strava_snapshot).toBe(snapshot);
  });
});

describe('saveV3State', () => {
  it('writes the whole state via the set_onboarding_state RPC', async () => {
    const db = makeRpcMock();
    vi.mocked(supabaseAdmin).mockReturnValue(db as AnyDB);
    const state = initialV3State(null);
    await saveV3State('a1', state);
    expect(db.rpc).toHaveBeenCalledWith('set_onboarding_state', {
      p_athlete_id: 'a1',
      p_new_state: state,
    });
  });

  it('throws on an RPC error', async () => {
    vi.mocked(supabaseAdmin).mockReturnValue(makeRpcMock({ message: 'boom' }) as AnyDB);
    await expect(saveV3State('a1', initialV3State(null))).rejects.toThrow('saveV3State failed');
  });
});

describe('initialV3State', () => {
  it('starts at orientation with the pinned budget and an empty schema', () => {
    const s = initialV3State(null);
    expect(s.flow).toBe('v3');
    expect(s.schema_version).toBe(V3_SCHEMA_VERSION);
    expect(s.phase).toBe('orientation');
    expect(s.optional_budget_remaining).toBe(DEFAULT_OPTIONAL_BUDGET);
    expect(DEFAULT_OPTIONAL_BUDGET).toBe(8);
    expect(s.slots).toEqual({});
    expect(s.asked).toEqual([]);
  });
});

// --- W3: Strava-inference pre-seed + experience-tier heuristic ---

function snapshot(overrides: Partial<StravaFitnessSnapshot> = {}): StravaFitnessSnapshot {
  return {
    window_days: 56,
    activity_count: 20,
    run_count: 20,
    weeks_observed: 8,
    recent_weekly_mileage_mi: 20,
    avg_weekly_mileage_mi: 18,
    longest_run_mi: 9,
    runs_per_week: 4,
    suggested_days_per_week: 4,
    dominant_long_run_weekday: 0,
    road_trail_mix: { road: 1, trail: 0 },
    ...overrides,
  };
}

describe('seedStravaInferences', () => {
  it('seeds days/week + long-run day as inferred/unconfirmed', () => {
    const slots = seedStravaInferences(
      {},
      snapshot({ suggested_days_per_week: 5, dominant_long_run_weekday: 6 }),
    );
    expect(slots.days_per_week).toEqual({ value: 5, provenance: 'inferred', confirmed: false });
    expect(slots.long_run_day).toEqual({ value: 6, provenance: 'inferred', confirmed: false });
  });

  it('omits long-run day when Strava has no dominant weekday', () => {
    const slots = seedStravaInferences({}, snapshot({ dominant_long_run_weekday: null }));
    expect(slots.long_run_day).toBeUndefined();
    expect(slots.days_per_week).toBeDefined();
  });

  it('never seeds experience — it is asked directly, not inferred from Strava', () => {
    const exp = seedStravaInferences(
      {},
      snapshot({ recent_weekly_mileage_mi: 35, longest_run_mi: 15 }),
    );
    expect(exp.experience_tier).toBeUndefined();
  });

  it('seeds nothing when there is no running signal', () => {
    expect(seedStravaInferences({}, snapshot({ run_count: 0 }))).toEqual({});
    expect(seedStravaInferences({}, null)).toEqual({});
  });

  it('preserves identity slots already on the map', () => {
    const slots = seedStravaInferences({ name: sv('Sam') }, snapshot());
    expect(slots.name?.value).toBe('Sam');
    expect(slots.days_per_week).toBeDefined();
  });
});

describe('isV3Enabled — default-on kill-switch (2026-06-05)', () => {
  const orig = process.env.ONBOARDING_V3;
  afterEach(() => {
    if (orig === undefined) delete process.env.ONBOARDING_V3;
    else process.env.ONBOARDING_V3 = orig;
  });

  it('is ON when the flag is unset (v3 is the default)', () => {
    delete process.env.ONBOARDING_V3;
    expect(isV3Enabled()).toBe(true);
  });

  it('stays ON for any non-disable value', () => {
    for (const v of ['true', '1', 'on', 'yes', '']) {
      process.env.ONBOARDING_V3 = v;
      expect(isV3Enabled()).toBe(true);
    }
  });

  it('is OFF only for an explicit disable value (the kill-switch)', () => {
    for (const v of ['false', '0', 'off', 'FALSE', 'Off']) {
      process.env.ONBOARDING_V3 = v;
      expect(isV3Enabled()).toBe(false);
    }
  });
});
