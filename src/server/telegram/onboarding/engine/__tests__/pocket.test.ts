import { describe, it, expect } from 'vitest';
import {
  applyStatedDistance,
  acceptPocketAndAdvance,
  declinePocket,
  reconcilePocket,
  setPocket,
} from '../pocket';
import { initialV3State, type V3OnboardingState } from '../../slots/slot-state';
import type { SlotState } from '../../slots/schema';
import type { Provenance, SlotValue } from '../../slots/provenance';

function sv<const T>(value: T, provenance: Provenance = 'stated', confirmed = true): SlotValue<T> {
  return { value, provenance, confirmed };
}

function stateWith(slots: SlotState, over: Partial<V3OnboardingState> = {}): V3OnboardingState {
  return { ...initialV3State(null), phase: 'intake', slots, ...over };
}

// Required slots minus the goal, so the generate gate's only open slot is the one
// the pocket fills (lets acceptPocketAndAdvance reach recap/generate).
function shapeSlots(): SlotState {
  return {
    goal_type: sv('race'),
    experience_tier: sv('some_training'),
    days_per_week: sv(4),
    long_run_day: sv(0),
    goal_date: sv('2026-09-15'),
    injury_status: sv('none'),
  };
}

describe('applyStatedDistance', () => {
  it('buckets an in-catalog stated distance in code (stated provenance)', () => {
    const r = applyStatedDistance(stateWith({}), 13, 'a half marathon, 13 miles');
    expect(r.pocket).toBe(false);
    expect(r.state.slots.goal_distance).toEqual(sv('half', 'stated', true));
    expect(r.state.out_of_catalog).toBeUndefined();
  });

  it('opens the pocket for an out-of-catalog stated distance', () => {
    const r = applyStatedDistance(stateWith({}), 44, '44 miles in the mountains');
    expect(r.pocket).toBe(true);
    expect(r.state.slots.goal_distance).toBeUndefined(); // never a nearest-bucket write
    expect(r.state.out_of_catalog).toMatchObject({
      words: '44 miles in the mountains',
      distance_mi: 44,
      proxy: 'marathon',
      consent: 'pending',
    });
    expect(r.message).toMatch(/past what I can build/i);
    expect(r.chips.map((c) => c.value)).toEqual(['yes', 'no']);
  });

  it('opens the pocket below the catalog floor with the 5k proxy (R1 fix 1)', () => {
    const r = applyStatedDistance(stateWith({}), 1, '1 mile in under 5 minutes');
    expect(r.pocket).toBe(true);
    expect(r.state.slots.goal_distance).toBeUndefined(); // the mile never silently becomes a 5K
    expect(r.state.out_of_catalog).toMatchObject({
      words: '1 mile in under 5 minutes',
      distance_mi: 1,
      proxy: '5k',
      consent: 'pending',
    });
    expect(r.message).toMatch(/5K block/);
    expect(r.message).toMatch(/mile-pace/);
    expect(r.chips.map((c) => c.value)).toEqual(['yes', 'no']);
  });

  it('a shapeless (null-distance) pocket still proxies to the marathon', () => {
    const state = setPocket(stateWith({}), 'be ready for anything', null);
    expect(state.out_of_catalog?.proxy).toBe('marathon');
  });
});

describe('acceptPocketAndAdvance', () => {
  it('writes the proxy distance (stated) and advances past the goal gate', () => {
    const state = setPocket(stateWith(shapeSlots()), 'Rae Lakes Loop, 44mi', 44);
    const resolved = acceptPocketAndAdvance(state);
    expect(resolved.state.slots.goal_distance).toEqual(sv('marathon', 'stated', true));
    expect(resolved.state.out_of_catalog?.consent).toBe('accepted');
    // every required slot now filled → the gate moves on (recap), not another ask
    expect(resolved.action).not.toBe('ask');
  });

  it('writes the 5k proxy for a short-side pocket (R1 fix 1)', () => {
    const state = setPocket(stateWith(shapeSlots()), '1 mile in under 5 minutes', 1);
    const resolved = acceptPocketAndAdvance(state);
    expect(resolved.state.slots.goal_distance).toEqual(sv('5k', 'stated', true));
    expect(resolved.state.out_of_catalog?.consent).toBe('accepted');
  });
});

describe('declinePocket', () => {
  it('clears the pocket and the goal slots so the goal re-asks', () => {
    const state = setPocket(
      stateWith({
        ...shapeSlots(),
        goal_race: sv('Western States'),
        goal_distance: sv('marathon'),
      }),
      'Western States, 100mi',
      100,
    );
    const r = declinePocket(state);
    expect(r.state.out_of_catalog).toBeUndefined();
    expect(r.state.slots.goal_race).toBeUndefined();
    expect(r.state.slots.goal_distance).toBeUndefined();
    expect(r.state.slots.goal_date).toBeUndefined();
    expect(r.message).toMatch(/want to aim at something/i);
  });
});

describe('reconcilePocket (typed path)', () => {
  const pocket = {
    words: 'a 50k',
    distance_mi: 31,
    proxy: 'marathon' as const,
    consent: 'pending' as const,
  };

  it('marks accepted when the model filled the proxy in prose', () => {
    const working = stateWith(
      { goal_distance: sv('marathon', 'stated') },
      { out_of_catalog: pocket },
    );
    expect(reconcilePocket(pocket, working).out_of_catalog?.consent).toBe('accepted');
  });

  it('drops the pocket when the athlete pivoted to a different distance', () => {
    const working = stateWith({ goal_distance: sv('half', 'stated') }, { out_of_catalog: pocket });
    expect(reconcilePocket(pocket, working).out_of_catalog).toBeUndefined();
  });

  it('leaves it pending while the distance is still open', () => {
    const working = stateWith({}, { out_of_catalog: pocket });
    expect(reconcilePocket(pocket, working).out_of_catalog?.consent).toBe('pending');
  });

  it('marks a short-side pocket accepted when the model filled its 5k proxy', () => {
    const shortPocket = {
      words: 'a sub-5 mile',
      distance_mi: 1,
      proxy: '5k' as const,
      consent: 'pending' as const,
    };
    const working = stateWith(
      { goal_distance: sv('5k', 'stated') },
      { out_of_catalog: shortPocket },
    );
    expect(reconcilePocket(shortPocket, working).out_of_catalog?.consent).toBe('accepted');
  });
});
