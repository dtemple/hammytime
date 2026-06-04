import { describe, it, expect } from 'vitest';
import {
  coerceFill,
  mergeFills,
  firstOpenRequired,
  firstUnconfirmedInferred,
  enforceGuardrails,
  buildRecapMessage,
} from '../guardrails';
import { initialV3State, type V3OnboardingState } from '../../slots/slot-state';
import type { SlotState } from '../../slots/schema';
import type { SlotValue, Provenance } from '../../slots/provenance';
import type { ExtractAdvanceOutput, SlotFill } from '../extract-and-advance';

function sv<const T>(value: T, provenance: Provenance = 'stated', confirmed = true): SlotValue<T> {
  return { value, provenance, confirmed };
}

function coreSlots(goalType: 'race' | 'general_fitness'): SlotState {
  const base: SlotState = {
    goal_type: sv(goalType),
    experience_tier: sv('some_training'),
    goal_distance: sv(goalType === 'race' ? 'marathon' : 'keep_fit'),
    days_per_week: sv(4),
    long_run_day: sv(0),
  };
  return goalType === 'race' ? { ...base, goal_date: sv('2026-11-01') } : base;
}

function out(partial: Partial<ExtractAdvanceOutput>): ExtractAdvanceOutput {
  return {
    fills: [],
    next_action: 'ask',
    message: 'msg',
    chips: [],
    asked_slot: null,
    race_lookup_query: null,
    contradiction: null,
    numeric_unresolved: null,
    ...partial,
  };
}

function fill(slot: SlotFill['slot'], value: unknown, provenance: Provenance = 'stated'): SlotFill {
  return { slot, value, provenance };
}

function stateWith(slots: SlotState, over: Partial<V3OnboardingState> = {}): V3OnboardingState {
  return { ...initialV3State(null), phase: 'intake', slots, ...over };
}

describe('coerceFill', () => {
  it('drops out-of-enum values', () => {
    expect(coerceFill('experience_tier', 'pro')).toBeUndefined();
    expect(coerceFill('goal_distance', '50k')).toBeUndefined();
    expect(coerceFill('experience_tier', 'beginner')).toBe('beginner');
  });
  it('rounds numeric slots and rejects non-numbers', () => {
    expect(coerceFill('days_per_week', '4')).toBe(4);
    expect(coerceFill('target_time', 15900.4)).toBe(15900);
    expect(coerceFill('age', 'old')).toBeUndefined();
  });
  it('validates injury_detail shape', () => {
    expect(coerceFill('injury_detail', { body_part: 'knee', status: 'active' })).toEqual({
      body_part: 'knee',
      status: 'active',
    });
    expect(coerceFill('injury_detail', { body_part: 'knee', status: 'twingey' })).toBeUndefined();
  });
});

describe('mergeFills', () => {
  it('marks inferred plan-driving fills unconfirmed, stated ones confirmed', () => {
    const merged = mergeFills({}, [
      fill('days_per_week', 4, 'inferred'),
      fill('goal_distance', 'marathon', 'stated'),
    ]);
    expect(merged.days_per_week!.confirmed).toBe(false);
    expect(merged.goal_distance!.confirmed).toBe(true);
  });
  it('rides non-critical inferred fills as confirmed', () => {
    const merged = mergeFills({}, [fill('age', 34, 'inferred')]);
    expect(merged.age!.confirmed).toBe(true);
  });
  it('never lets injury_status become "none" by inference', () => {
    const merged = mergeFills({}, [fill('injury_status', 'none', 'inferred')]);
    expect(merged.injury_status!.value).toBe('unknown');
    expect(merged.injury_status!.provenance).toBe('unknown');
  });
  it('keeps an explicit "none"', () => {
    const merged = mergeFills({}, [fill('injury_status', 'none', 'stated')]);
    expect(merged.injury_status!.value).toBe('none');
  });
});

describe('firstOpenRequired / firstUnconfirmedInferred', () => {
  it('finds an open required slot (goal-type aware)', () => {
    const slots = coreSlots('race');
    delete slots.days_per_week;
    expect(firstOpenRequired(slots)).toBe('days_per_week');
    expect(firstOpenRequired(coreSlots('general_fitness'))).toBeNull();
  });
  it('finds an unconfirmed inferred critical slot', () => {
    const slots = { ...coreSlots('race'), days_per_week: sv(4, 'inferred', false) };
    expect(firstUnconfirmedInferred(slots)).toBe('days_per_week');
  });
});

describe('enforceGuardrails — generate gate', () => {
  it('blocks generate with an open required slot and asks for it', () => {
    const slots = coreSlots('race');
    delete slots.experience_tier;
    const r = enforceGuardrails(
      stateWith(slots),
      out({ next_action: 'generate', message: "Here's your plan" }),
    );
    expect(r.action).toBe('ask');
    expect(r.overridden).toBe(true);
    expect(r.message).toMatch(/experience/);
  });

  it('blocks generate on an unconfirmed inferred plan-driving slot and confirms it', () => {
    const slots = {
      ...coreSlots('race'),
      injury_status: sv('none'),
      days_per_week: sv(4, 'inferred', false),
    };
    const r = enforceGuardrails(stateWith(slots), out({ next_action: 'generate' }));
    expect(r.action).toBe('confirm');
    expect(r.message).toMatch(/days per week/);
    expect(r.chips.length).toBe(2);
  });

  it('blocks generate when the injury beat is unanswered', () => {
    const r = enforceGuardrails(stateWith(coreSlots('race')), out({ next_action: 'generate' }));
    expect(r.action).toBe('recap');
    expect(r.overridden).toBe(true);
  });

  it('lets generate through when everything is satisfied', () => {
    const slots = { ...coreSlots('race'), injury_status: sv('none') };
    const r = enforceGuardrails(
      stateWith(slots),
      out({ next_action: 'generate', message: 'building it' }),
    );
    expect(r.action).toBe('generate');
    expect(r.overridden).toBe(false);
  });
});

describe('enforceGuardrails — optional budget', () => {
  it('decrements the budget on an optional ask', () => {
    const r = enforceGuardrails(
      stateWith(coreSlots('race'), { optional_budget_remaining: 8 }),
      out({ next_action: 'ask', asked_slot: 'age' }),
    );
    expect(r.action).toBe('ask');
    expect(r.state.optional_budget_remaining).toBe(7);
  });

  it('does not charge budget for a required ask', () => {
    const r = enforceGuardrails(
      stateWith({}, { optional_budget_remaining: 8 }),
      out({ next_action: 'ask', asked_slot: 'goal_distance' }),
    );
    expect(r.state.optional_budget_remaining).toBe(8);
  });

  it('forces a recap when an optional ask would overrun a spent budget', () => {
    const slots = { ...coreSlots('race'), injury_status: sv('none') };
    const r = enforceGuardrails(
      stateWith(slots, { optional_budget_remaining: 0 }),
      out({ next_action: 'ask', asked_slot: 'age' }),
    );
    expect(r.action).toBe('recap');
    expect(r.overridden).toBe(true);
    expect(r.state.phase).toBe('recap');
  });
});

describe('enforceGuardrails — passthrough + asked tracking', () => {
  it('passes a normal ask through and records the asked slot', () => {
    const r = enforceGuardrails(
      stateWith({}),
      out({ next_action: 'ask', asked_slot: 'injury_status', message: 'any injuries?' }),
    );
    expect(r.action).toBe('ask');
    expect(r.overridden).toBe(false);
    expect(r.message).toBe('any injuries?');
    expect(r.state.asked).toContain('injury_status');
  });

  it('advances orientation → intake on the first turn', () => {
    const r = enforceGuardrails(
      stateWith({}, { phase: 'orientation' }),
      out({ next_action: 'ask', asked_slot: 'goal_type' }),
    );
    expect(r.state.phase).toBe('intake');
  });
});

// --- W3: field-targeted correction (a fix re-opens one slot, rest intact) ---

describe('mergeFills — field-targeted correction', () => {
  it('updates only the named slot and leaves the rest untouched', () => {
    const slots = coreSlots('race');
    const before = slots.long_run_day;
    const merged = mergeFills(slots, [{ slot: 'days_per_week', value: 5, provenance: 'stated' }]);
    expect(merged.days_per_week?.value).toBe(5);
    // every other slot is the same object reference — nothing else was rewritten
    expect(merged.long_run_day).toBe(before);
    expect(merged.goal_distance).toBe(slots.goal_distance);
    expect(merged.experience_tier).toBe(slots.experience_tier);
  });
});

// --- W3: a pre-seeded inferred plan-driving slot forces a confirm before gen ---

describe('pre-seeded Strava inference → forced confirm', () => {
  it('blocks generate on an unconfirmed inferred days_per_week with a confirm turn', () => {
    const slots = coreSlots('race');
    // simulate the strava-resume seed: inferred, unconfirmed
    slots.days_per_week = sv(4, 'inferred', false);
    const r = enforceGuardrails(stateWith(slots), out({ next_action: 'generate' }));
    expect(r.action).toBe('confirm');
    expect(r.overridden).toBe(true);
  });

  it('firstUnconfirmedInferred flags the seeded slot, and a confirm clears it', () => {
    const slots = coreSlots('race');
    slots.long_run_day = sv(0, 'inferred', false);
    expect(firstUnconfirmedInferred(slots)).toBe('long_run_day');
    // athlete confirms → flips to confirmed; no longer blocks
    const confirmed = mergeFills(slots, [{ slot: 'long_run_day', value: 0, provenance: 'stated' }]);
    expect(firstUnconfirmedInferred(confirmed)).toBe(null);
  });
});

// --- W3: the full-picture recap copy ---

describe('buildRecapMessage', () => {
  it('echoes a committed race, schedule, injuries, and goal time in the athlete voice', () => {
    const slots: SlotState = {
      ...coreSlots('race'),
      name: sv('Sam'),
      goal_race: sv('CIM'),
      goal_date: sv('2026-12-06'),
      target_time: sv(13500), // 3:45:00
      injury_status: sv('none'),
    };
    const msg = buildRecapMessage(stateWith(slots));
    expect(msg).toContain('Sam'); // personal greeting
    expect(msg).toContain('CIM');
    expect(msg).toContain('2026-12-06');
    expect(msg).toContain('marathon');
    expect(msg).toContain('nothing bothering you'); // injury_status none
    expect(msg).toContain('3:45:00'); // goal time rendered
    expect(msg).toContain('Look right?');
  });

  it('renders a general-fitness goal without a race', () => {
    const slots: SlotState = { ...coreSlots('general_fitness'), goal_distance: sv('keep_fit') };
    const msg = buildRecapMessage(stateWith(slots));
    expect(msg).toContain('no race');
    expect(msg).not.toContain('Race:');
  });

  it('surfaces a described injury over the bare status', () => {
    const slots: SlotState = {
      ...coreSlots('race'),
      injury_status: sv('monitoring'),
      injury_detail: sv({ body_part: 'left knee', status: 'monitoring' }),
    };
    const msg = buildRecapMessage(stateWith(slots));
    expect(msg).toContain('left knee');
  });
});
