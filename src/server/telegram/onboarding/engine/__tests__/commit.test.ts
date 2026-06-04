import { describe, it, expect } from 'vitest';
import { buildGoalWrite, mapInjuryStatus } from '../commit';
import { initialV3State, type V3OnboardingState } from '../../slots/slot-state';
import type { SlotState } from '../../slots/schema';
import type { SlotValue, Provenance } from '../../slots/provenance';

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
});

describe('mapInjuryStatus', () => {
  it('maps slot status to the injuries enum (past → resolved)', () => {
    expect(mapInjuryStatus('past')).toBe('resolved');
    expect(mapInjuryStatus('active')).toBe('active');
    expect(mapInjuryStatus('monitoring')).toBe('monitoring');
  });
});
