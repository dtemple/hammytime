import { describe, it, expect } from 'vitest';
import {
  applyStatedDistance,
  applyUltraOffRamp,
  applyVolumeGoal,
  acceptPocketAndAdvance,
  declinePocket,
  formatShortTarget,
  pocketBody,
  POCKET_CHIPS,
  REFLECTION_POCKET_CHIPS,
  reconcilePocket,
  setPocket,
  supersedePocket,
  ultraOffRampBody,
  volumeBoundaryBody,
  VOLUME_REDIRECT_CHIPS,
} from '../pocket';
import { initialV3State, type V3OnboardingState } from '../../slots/slot-state';
import type { SlotState } from '../../slots/schema';
import type { Provenance, SlotValue } from '../../slots/provenance';
import type { ExtractAdvanceOutput } from '../extract-and-advance';

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

  it('buckets a 50k stated distance in catalog (V4-W4) — no pocket', () => {
    const r = applyStatedDistance(stateWith({}), 35, 'a 35-mile trail ultra');
    expect(r.pocket).toBe(false);
    expect(r.state.slots.goal_distance).toEqual(sv('50k', 'stated', true));
    expect(r.state.out_of_catalog).toBeUndefined();
  });

  it('off-ramps a beyond-50k stated distance — no pocket, asks for a shorter event (V4-W4)', () => {
    const r = applyStatedDistance(stateWith({}), 44, '44 miles in the mountains');
    expect(r.pocket).toBe(false);
    expect(r.state.slots.goal_distance).toBeUndefined(); // no nearest-bucket write, no proxy
    expect(r.state.out_of_catalog).toBeUndefined(); // off-ramp, not a pocket
    expect(r.state.intents).toEqual(['44 miles in the mountains']); // rides as coach context
    expect(r.message).toMatch(/top out at the 50k/i);
    expect(r.message).toMatch(/shorter event or a tune-up/i);
    expect(r.chips).toEqual([]); // no consent chips
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

describe('ultraOffRampBody + applyUltraOffRamp (V4-W4 — the beyond-50k off-ramp)', () => {
  it('states the 50k ceiling and asks for a shorter event, with no keep_fit path', () => {
    const body = ultraOffRampBody(100);
    expect(body).toContain('100 miles is');
    expect(body).toMatch(/top out at the 50k/i);
    expect(body).toMatch(/shorter event or a tune-up/i);
    // v4 is event-only — never offers "keep you fit" / "stay fit"
    expect(body.toLowerCase()).not.toContain('keep you fit');
    expect(body.toLowerCase()).not.toContain('stay fit');
    // no promise to reach back out when 50mi+ ships (nothing remembers to)
    expect(body.toLowerCase()).not.toContain('check back');
  });

  it('clears the goal slots and demotes the words to an intent (no pocket)', () => {
    const state = stateWith({
      goal_race: sv('Western States'),
      goal_date: sv('2026-06-27'),
      goal_distance: sv('marathon'),
    });
    const next = applyUltraOffRamp(state, 'Western States, 100mi');
    expect(next.slots.goal_race).toBeUndefined();
    expect(next.slots.goal_date).toBeUndefined();
    expect(next.slots.goal_distance).toBeUndefined();
    expect(next.out_of_catalog).toBeUndefined();
    expect(next.intents).toEqual(['Western States, 100mi']);
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

describe('supersedePocket (the stale-pocket pivot fix)', () => {
  it('clears an ACCEPTED pocket and demotes its words to the intents', () => {
    const state = stateWith(
      {},
      {
        out_of_catalog: {
          words: '44 miles in the mountains',
          distance_mi: 44,
          proxy: 'marathon',
          consent: 'accepted',
        },
      },
    );
    const next = supersedePocket(state);
    expect(next.out_of_catalog).toBeUndefined();
    expect(next.intents).toEqual(['44 miles in the mountains']);
  });

  it('clears a PENDING pocket too — a confirmed race supersedes either way', () => {
    const state = setPocket(stateWith({}), 'Western States, 100mi', 100);
    const next = supersedePocket(state);
    expect(next.out_of_catalog).toBeUndefined();
    expect(next.intents).toEqual(['Western States, 100mi']);
  });

  it('is the identity without a pocket', () => {
    const state = stateWith({}, { intents: ['build strength'] });
    expect(supersedePocket(state)).toBe(state);
  });

  it('dedupes against an intent already carrying the words', () => {
    const state = stateWith(
      {},
      {
        intents: ['44 miles in the mountains'],
        out_of_catalog: {
          words: '44 miles in the mountains',
          distance_mi: 44,
          proxy: 'marathon',
          consent: 'accepted',
        },
      },
    );
    expect(supersedePocket(state).intents).toEqual(['44 miles in the mountains']);
  });
});

// ---------------------------------------------------------------------------
// R2 — reflection chips, target templating, the decline-as-redo path
// ---------------------------------------------------------------------------

describe('pocketBody — target-time templating (R2)', () => {
  it('templates a known short-side target deterministically, M:SS form', () => {
    expect(pocketBody(1, 300)).toContain('treating 5:00 as the goal');
  });

  it('falls back to "your target" when no time is known', () => {
    expect(pocketBody(1)).toContain('treating your target as the goal');
  });

  it('leaves the long side untouched (no target templating)', () => {
    expect(pocketBody(100, 86400)).toMatch(/point you at it as the target/);
  });
});

describe('applyStatedDistance — carries the same-turn target into the offer (R2)', () => {
  it('reads target_time off the (already merged) state', () => {
    const r = applyStatedDistance(
      stateWith({ target_time: sv(300) }),
      1,
      '1 mile in under 5 minutes',
    );
    expect(r.message).toContain('treating 5:00 as the goal');
  });
});

describe('REFLECTION_POCKET_CHIPS (R2)', () => {
  it('keeps the fast-path values, renames only the decline', () => {
    expect(REFLECTION_POCKET_CHIPS.map((c) => c.value)).toEqual(['yes', 'no']);
    expect(REFLECTION_POCKET_CHIPS.map((c) => c.label)).toEqual(['Do that', 'Not quite my goal']);
    expect(POCKET_CHIPS.map((c) => c.label)).toEqual(['Do that', 'Not now']);
  });
});

describe('declinePocket — the reflection redo (R2)', () => {
  function reflectedPocket(over: Partial<V3OnboardingState> = {}): V3OnboardingState {
    return setPocket(
      stateWith(shapeSlots(), {
        reflected: true,
        intents: ['speed at shorter distances', 'build strength'],
        ...over,
      }),
      '1 mile in under 5 minutes',
      1,
    );
  }

  it('the first decline after a reflection re-arms it and asks for a restatement', () => {
    const r = declinePocket(reflectedPocket());
    expect(r.state.reflected).toBe(false);
    expect(r.state.reflection_redone).toBe(true);
    expect(r.message).toMatch(/tell me again what you're going for/i);
    // intents survive — they're context, not goal slots
    expect(r.state.intents).toEqual(['speed at shorter distances', 'build strength']);
    expect(r.state.out_of_catalog).toBeUndefined();
  });

  it('the redo is spent after one use — a second decline takes the standard path', () => {
    const r = declinePocket(reflectedPocket({ reflection_redone: true }));
    expect(r.state.reflected).toBe(true);
    expect(r.message).toMatch(/want to aim at something/i);
  });

  it('a pre-R2 state (reflected undefined) declines on the standard path', () => {
    const r = declinePocket(setPocket(stateWith(shapeSlots()), 'Western States, 100mi', 100));
    expect(r.state.reflected).toBeUndefined();
    expect(r.message).toMatch(/want to aim at something/i);
  });
});

// ---------------------------------------------------------------------------
// Volume goals (ULTRA_SUPPORT §6 interim — acknowledge, boundary, redirect)
// ---------------------------------------------------------------------------

function vout(partial: Partial<ExtractAdvanceOutput> = {}): ExtractAdvanceOutput {
  return {
    fills: [],
    next_action: 'ask',
    message: 'msg',
    chips: [],
    asked_slot: null,
    race_lookup_query: null,
    goal_distance_mi: null,
    contradiction: null,
    numeric_unresolved: null,
    intents: [],
    reflection: null,
    volume_goal: null,
    ...partial,
  };
}

describe('applyVolumeGoal', () => {
  it('normalizes a monthly target to weekly miles and appends the clause as an intent', () => {
    const r = applyVolumeGoal(stateWith({}), { miles: 100, period: 'month' }, vout());
    expect(r.miPerWeek).toBe(23); // 100 / 4.345
    expect(r.boundary).toBe(true);
    expect(r.state.intents).toEqual(['100 miles a month']);
  });

  it('a weekly target passes through unconverted', () => {
    const r = applyVolumeGoal(stateWith({}), { miles: 20, period: 'week' }, vout());
    expect(r.miPerWeek).toBe(20);
    expect(r.state.intents).toEqual(['20 miles a week']);
  });

  it('a restated target is not new — no boundary, no duplicate intent', () => {
    const r = applyVolumeGoal(
      stateWith({}, { intents: ['100 miles a month'] }),
      { miles: 100, period: 'month' },
      vout(),
    );
    expect(r.boundary).toBe(false);
    expect(r.state.intents).toEqual(['100 miles a month']);
  });

  it('a race in state demotes silently (goal_type race / named race / non-keep_fit distance)', () => {
    for (const slots of [
      { goal_type: sv('race') },
      { goal_race: sv('CIM') },
      { goal_distance: sv('marathon') },
    ]) {
      const r = applyVolumeGoal(stateWith(slots), { miles: 100, period: 'month' }, vout());
      expect(r.boundary).toBe(false);
      expect(r.state.intents).toEqual(['100 miles a month']);
    }
  });

  it('keep_fit in state is NOT a race in play — the boundary still fires', () => {
    const r = applyVolumeGoal(
      stateWith({ goal_distance: sv('keep_fit') }),
      { miles: 100, period: 'month' },
      vout(),
    );
    expect(r.boundary).toBe(true);
  });

  it('same-turn race signals demote silently (lookup query / stated distance)', () => {
    for (const o of [vout({ race_lookup_query: 'CIM' }), vout({ goal_distance_mi: 44 })]) {
      const r = applyVolumeGoal(stateWith({}), { miles: 60, period: 'month' }, o);
      expect(r.boundary).toBe(false);
      expect(r.state.intents).toEqual(['60 miles a month']);
    }
  });
});

describe('volumeBoundaryBody + VOLUME_REDIRECT_CHIPS', () => {
  it('states the boundary plainly and offers the two paths', () => {
    const monthly = volumeBoundaryBody('month');
    expect(monthly).toContain(
      "A monthly mileage target isn't something I can coach you toward yet",
    );
    expect(monthly).toContain('keep you generally fit');
    expect(monthly).toContain('train you for a race');
    expect(monthly.endsWith('?')).toBe(true);
    expect(volumeBoundaryBody('week')).toContain('A weekly mileage target');
  });

  it('redirect chips are plain typed-text values, not consent tokens', () => {
    expect(VOLUME_REDIRECT_CHIPS.map((c) => c.label)).toEqual(['Keep me fit', 'Train for a race']);
    for (const c of VOLUME_REDIRECT_CHIPS) {
      expect(['yes', 'no']).not.toContain(c.value); // never trips the consent fast path
    }
  });
});

describe('formatShortTarget', () => {
  it('renders sub-hour targets as M:SS and longer ones as H:MM:SS', () => {
    expect(formatShortTarget(300)).toBe('5:00');
    expect(formatShortTarget(14154)).toBe('3:55:54');
  });
});
