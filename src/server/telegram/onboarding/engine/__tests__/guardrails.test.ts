import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  coerceFill,
  mergeFills,
  firstOpenRequired,
  firstUnconfirmedInferred,
  enforceGuardrails,
  resolveConfirmAndAdvance,
  resolveRecapAffirmAndAdvance,
  recapDisplayedSlots,
  applyChipPolicy,
  buildRecapMessage,
  formatSlotValue,
  mergeIntents,
  INTENTS_CAP,
} from '../guardrails';
import { buildGoalWrite } from '../commit';
import { INJURY_CHIPS, SLOT_CHIPS } from '../../slots/chips';
import { hasReflected, initialV3State, type V3OnboardingState } from '../../slots/slot-state';
import type { SlotKey, SlotState } from '../../slots/schema';
import type { SlotValue, Provenance } from '../../slots/provenance';
import type { ExtractAdvanceOutput, SlotFill } from '../extract-and-advance';

// Pin the clock: the past-goal_date guard (R1 fix 3) compares fixture dates to
// "today", so without this the 2026 fixtures rot into the past and the suite
// starts failing on its own schedule.
beforeAll(() => vi.useFakeTimers({ now: new Date('2026-06-10T12:00:00-07:00'), toFake: ['Date'] }));
afterAll(() => vi.useRealTimers());

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
    goal_distance_mi: null,
    goal_pace_sec_per_mi: null,
    contradiction: null,
    numeric_unresolved: null,
    intents: [],
    reflection: null,
    volume_goal: null,
    event_kind: null,
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
    expect(coerceFill('goal_distance', '100k')).toBeUndefined(); // beyond the 50k → off-ramp, not a bucket
    expect(coerceFill('goal_distance', '50k')).toBe('50k'); // the 50k IS in catalog now (V4-W4)
    expect(coerceFill('experience_tier', 'beginner')).toBe('beginner');
  });
  it('drops the prose "intermediate" label that stranded the loop; accepts every tier literal', () => {
    // The §5 bug: the model emitted "intermediate" (not in the enum), it was
    // silently dropped, and experience_tier never filled.
    expect(coerceFill('experience_tier', 'intermediate')).toBeUndefined();
    for (const tier of ['beginner', 'for_fun', 'some_training', 'experienced']) {
      expect(coerceFill('experience_tier', tier)).toBe(tier);
    }
  });
  it('rounds numeric slots and rejects non-numbers', () => {
    expect(coerceFill('days_per_week', '4')).toBe(4);
    expect(coerceFill('target_time', 15900.4)).toBe(15900);
    expect(coerceFill('age', 'old')).toBeUndefined();
  });
  it('drops out-of-range day-coded slots that would violate the DB CHECK and strand the commit', () => {
    // The blocker: Sunday emitted as ISO 7 survived rounding, passed the gate,
    // then blew up `long_run_day between 0 and 6` at commit → "Hit a snag saving
    // your profile". Out-of-range now drops so the gate re-asks instead.
    expect(coerceFill('long_run_day', 7)).toBeUndefined();
    expect(coerceFill('long_run_day', -1)).toBeUndefined();
    expect(coerceFill('long_run_day', 0)).toBe(0);
    expect(coerceFill('long_run_day', 6)).toBe(6);
    expect(coerceFill('days_per_week', 2)).toBeUndefined();
    expect(coerceFill('days_per_week', 8)).toBeUndefined();
    expect(coerceFill('days_per_week', 3)).toBe(3);
    expect(coerceFill('days_per_week', 7)).toBe(7);
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
  it('never lets injury_status become "none" by inference — the fill is dropped', () => {
    const merged = mergeFills({}, [fill('injury_status', 'none', 'inferred')]);
    expect(merged.injury_status).toBeUndefined(); // left open, not a stored value
  });
  it('keeps an explicit "none"', () => {
    const merged = mergeFills({}, [fill('injury_status', 'none', 'stated')]);
    expect(merged.injury_status!.value).toBe('none');
  });
});

// --- Confirm-loop fix (2026-06-05): merge monotonicity ---

describe('mergeFills — monotonicity (the confirm-loop fix)', () => {
  it('a re-emitted inferred value equal to a confirmed one keeps it confirmed and does not downgrade', () => {
    const merged = mergeFills({ days_per_week: sv(3, 'stated', true) }, [
      fill('days_per_week', 3, 'inferred'),
    ]);
    expect(merged.days_per_week!.confirmed).toBe(true);
    expect(merged.days_per_week!.provenance).toBe('stated');
  });

  it('a re-emitted inferred value equal to an unconfirmed seed stays unconfirmed (no spurious flip)', () => {
    const merged = mergeFills({ days_per_week: sv(3, 'inferred', false) }, [
      fill('days_per_week', 3, 'inferred'),
    ]);
    expect(merged.days_per_week!.confirmed).toBe(false);
    expect(merged.days_per_week!.provenance).toBe('inferred');
  });

  it('a stated re-emit of an unconfirmed inferred value confirms it (an affirmation resolves the confirm)', () => {
    const merged = mergeFills({ days_per_week: sv(3, 'inferred', false) }, [
      fill('days_per_week', 3, 'stated'),
    ]);
    expect(merged.days_per_week!.confirmed).toBe(true);
    expect(merged.days_per_week!.provenance).toBe('stated');
  });

  it('a changed value still resets the confirm', () => {
    const merged = mergeFills({ days_per_week: sv(3, 'inferred', false) }, [
      fill('days_per_week', 5, 'inferred'),
    ]);
    expect(merged.days_per_week!.value).toBe(5);
    expect(merged.days_per_week!.confirmed).toBe(false);
  });

  it('a re-emitted inferred "none" never wipes a confirmed stated injury answer', () => {
    const merged = mergeFills({ injury_status: sv('none', 'stated', true) }, [
      fill('injury_status', 'none', 'inferred'),
    ]);
    expect(merged.injury_status!.value).toBe('none');
    expect(merged.injury_status!.provenance).toBe('stated');
    expect(merged.injury_status!.confirmed).toBe(true);
  });
});

// --- Stale goal_date fix (2026-06-05) ---

describe('mergeFills — goal_date invalidation on a goal-race change', () => {
  it('clears the date when goal_race changes with no goal_date in the delta (Broken Arrow → Rae Lakes)', () => {
    const slots: SlotState = {
      goal_race: sv('Broken Arrow Skyrace 18K'),
      goal_date: sv('2026-06-19'),
    };
    const merged = mergeFills(slots, [fill('goal_race', 'Rae Lakes Loop')]);
    expect(merged.goal_race!.value).toBe('Rae Lakes Loop');
    expect(merged.goal_date!.value).toBeNull();
    expect(merged.goal_date!.provenance).toBe('unknown');
  });

  it('keeps the date when the same delta re-supplies goal_date', () => {
    const slots: SlotState = { goal_race: sv('Broken Arrow'), goal_date: sv('2026-06-19') };
    const merged = mergeFills(slots, [
      fill('goal_race', 'Rae Lakes Loop'),
      fill('goal_date', '2026-09-12'),
    ]);
    expect(merged.goal_date!.value).toBe('2026-09-12');
  });

  it('keeps the date when goal_race is re-emitted unchanged', () => {
    const slots: SlotState = { goal_race: sv('Broken Arrow'), goal_date: sv('2026-06-19') };
    const merged = mergeFills(slots, [fill('goal_race', 'Broken Arrow', 'inferred')]);
    expect(merged.goal_date!.value).toBe('2026-06-19');
  });
});

// --- W8: a goal-race change also invalidates the code-derived distance ---

describe('mergeFills — goal_distance invalidation on a goal-race change (V3-W8)', () => {
  it('clears the derived distance when goal_race changes with no goal_distance in the delta', () => {
    const slots: SlotState = {
      goal_race: sv('CIM'),
      goal_distance: sv('marathon'),
      goal_date: sv('2026-12-06'),
    };
    const merged = mergeFills(slots, [fill('goal_race', 'Shamrock Half')]);
    expect(merged.goal_distance!.value).toBeNull();
    expect(merged.goal_distance!.provenance).toBe('unknown');
  });

  it('keeps the distance when the same delta re-supplies it', () => {
    const slots: SlotState = { goal_race: sv('CIM'), goal_distance: sv('marathon') };
    const merged = mergeFills(slots, [
      fill('goal_race', 'Shamrock Half'),
      fill('goal_distance', 'half'),
    ]);
    expect(merged.goal_distance!.value).toBe('half');
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
    expect(r.message).toMatch(/describe yourself as a runner/i); // the whole-history experience ask
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
    expect(r.chips).toEqual([]); // a confirm is chip-free now — the athlete types or taps a model chip
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

describe('enforceGuardrails — pending-confirm bookkeeping (the confirm-loop fix)', () => {
  function seeded(over: Partial<V3OnboardingState> = {}): V3OnboardingState {
    const slots = {
      ...coreSlots('race'),
      injury_status: sv('none'),
      days_per_week: sv(4, 'inferred', false),
    };
    return stateWith(slots, over);
  }

  it('records pending_confirm (attempts 1) when the generate gate issues a confirm', () => {
    const r = enforceGuardrails(seeded(), out({ next_action: 'generate' }));
    expect(r.action).toBe('confirm');
    expect(r.state.pending_confirm).toEqual({ slot: 'days_per_week', value: 4, attempts: 1 });
  });

  it('increments attempts on a same-slot+value re-issue', () => {
    const r = enforceGuardrails(
      seeded({ pending_confirm: { slot: 'days_per_week', value: 4, attempts: 1 } }),
      out({ next_action: 'generate' }),
    );
    expect(r.action).toBe('confirm');
    expect(r.state.pending_confirm?.attempts).toBe(2);
  });

  it('switches to a direct plain-words ask on the would-be third confirm, clearing pending_confirm', () => {
    const r = enforceGuardrails(
      seeded({ pending_confirm: { slot: 'days_per_week', value: 4, attempts: 2 } }),
      out({ next_action: 'generate' }),
    );
    expect(r.action).toBe('ask');
    expect(r.overridden).toBe(true);
    expect(r.message).toMatch(/how many days a week/i);
    expect(r.message).not.toMatch(/Right\?/);
    expect(r.state.pending_confirm).toBeUndefined();
  });

  it('clears a stale pending_confirm on any non-confirm resolution', () => {
    const r = enforceGuardrails(
      stateWith({}, { pending_confirm: { slot: 'days_per_week', value: 4, attempts: 1 } }),
      out({ next_action: 'ask', asked_slot: 'goal_distance' }),
    );
    expect(r.state.pending_confirm).toBeUndefined();
  });
});

describe('resolveConfirmAndAdvance — chip-yes deterministic resolution', () => {
  it('confirms the pending slot in code and advances to generate', () => {
    const slots = {
      ...coreSlots('race'),
      injury_status: sv('none'),
      days_per_week: sv(4, 'inferred', false),
    };
    const r = resolveConfirmAndAdvance(
      stateWith(slots, { pending_confirm: { slot: 'days_per_week', value: 4, attempts: 1 } }),
    );
    expect(r.state.slots.days_per_week?.confirmed).toBe(true);
    expect(r.state.slots.days_per_week?.provenance).toBe('stated');
    expect(r.action).toBe('generate');
    expect(r.state.pending_confirm).toBeUndefined();
  });

  it('chains to the next confirm when another inferred slot is unconfirmed', () => {
    const slots = {
      ...coreSlots('race'),
      injury_status: sv('none'),
      days_per_week: sv(4, 'inferred', false),
      long_run_day: sv(0, 'inferred', false),
    };
    const r = resolveConfirmAndAdvance(
      stateWith(slots, { pending_confirm: { slot: 'days_per_week', value: 4, attempts: 1 } }),
    );
    expect(r.action).toBe('confirm');
    expect(r.state.pending_confirm).toEqual({ slot: 'long_run_day', value: 0, attempts: 1 });
  });
});

describe('regression — the chase confirm loop terminates', () => {
  it('a seeded inferred days_per_week resolves on a yes instead of re-confirming forever', () => {
    const slots = {
      ...coreSlots('race'),
      injury_status: sv('none'),
      days_per_week: sv(3, 'inferred', false),
    };
    // the gate issues the confirm and records it pending
    const first = enforceGuardrails(stateWith(slots), out({ next_action: 'generate' }));
    expect(first.action).toBe('confirm');
    expect(first.state.pending_confirm).toEqual({ slot: 'days_per_week', value: 3, attempts: 1 });
    // a "Looks right" tap resolves it deterministically → generate, not loop
    const second = resolveConfirmAndAdvance(first.state);
    expect(second.action).toBe('generate');
    expect(second.state.pending_confirm).toBeUndefined();
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
    expect(msg).toContain('Dec 6, 2026'); // human-readable, never raw ISO (R1 fix 3)
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

  it('appends the implied pace to the goal-time line (pace-fix belt-and-suspenders)', () => {
    const slots: SlotState = {
      ...coreSlots('race'), // goal_distance = 'marathon'
      target_time: sv(15720), // 10:00/mi × 26.2
      injury_status: sv('none'),
    };
    const msg = buildRecapMessage(stateWith(slots));
    expect(msg).toContain('• Goal time: 4:22:00 (~10:00/mi)');
  });

  it('derives the recap pace from the real pocketed miles, not the bucket nominal', () => {
    const slots: SlotState = {
      ...coreSlots('race'),
      goal_distance: sv('5k'), // the proxy bucket
      target_time: sv(300), // a 5:00 mile
      injury_status: sv('none'),
    };
    const msg = buildRecapMessage(
      stateWith(slots, {
        out_of_catalog: { words: 'a fast mile', distance_mi: 1, proxy: '5k', consent: 'accepted' },
      }),
    );
    expect(msg).toContain('(~5:00/mi)'); // 300s ÷ 1 mi, not ÷ 3.1
  });

  it('recaps the real out-of-catalog goal, not the marathon-proxy (V3-W8)', () => {
    const slots: SlotState = {
      ...coreSlots('race'),
      goal_distance: sv('marathon'),
      injury_status: sv('none'),
    };
    const msg = buildRecapMessage(
      stateWith(slots, {
        out_of_catalog: {
          words: 'Rae Lakes Loop',
          distance_mi: 44,
          proxy: 'marathon',
          consent: 'accepted',
        },
      }),
    );
    expect(msg).toContain('Rae Lakes Loop');
    expect(msg).toContain('44 mi');
    expect(msg).toContain('marathon block');
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

  it('frames an adventure as "your run" with the real distance (V4-W4b)', () => {
    const slots: SlotState = {
      ...coreSlots('race'),
      goal_distance: sv('50k'),
      goal_race: sv('Rae Lakes Loop'),
      goal_date: sv('2026-09-15'),
      injury_status: sv('none'),
    };
    const msg = buildRecapMessage(
      stateWith(slots, { event_kind: 'adventure', event_distance_mi: 33 }),
    );
    expect(msg).toContain('Your run: Rae Lakes Loop');
    expect(msg).toContain('33 mi');
    expect(msg).toContain('your own adventure');
    expect(msg).not.toContain('• Race:'); // never reads as an organized race
  });
});

// --- W4: hybrid chips — the deterministic chip policy ---

const YES_FIX_LABELS = ['Looks right', 'Fix it'];

describe('applyChipPolicy', () => {
  it('attaches the canonical set for a closed-option ask', () => {
    expect(applyChipPolicy('ask', 'goal_distance', []).map((c) => c.value)).toEqual([
      '5k',
      '10k',
      'half',
      'marathon',
    ]);
  });

  it('attaches the single injury beat chip for an injury ask', () => {
    expect(applyChipPolicy('ask', 'injury_status', []).map((c) => c.label)).toEqual([
      'Nothing right now',
    ]);
  });

  it('overrides whatever chips the model proposed for a closed slot', () => {
    const r = applyChipPolicy('ask', 'goal_distance', [{ label: 'X', value: 'x' }]);
    expect(r.map((c) => c.label)).toEqual(['5K', '10K', 'Half', 'Marathon']);
  });

  it('forces the event-led goal_type opener (no staying-fit tap)', () => {
    const r = applyChipPolicy('ask', 'goal_type', [{ label: 'Just staying fit', value: 'keep_fit' }]);
    expect(r.map((c) => c.label)).toEqual(['A race', 'Personal goal with a date']);
  });

  it('leaves an open-slot ask with the model chips (no forced set)', () => {
    expect(applyChipPolicy('ask', 'schedule_constraints', [])).toEqual([]);
    const shortcut = [{ label: 'Mornings', value: 'mornings' }];
    expect(applyChipPolicy('ask', 'schedule_constraints', shortcut)).toBe(shortcut);
  });

  it('owes only the recap a yes-no set; a confirm carries the model chips (or none)', () => {
    expect(applyChipPolicy('recap', null, []).map((c) => c.label)).toEqual(YES_FIX_LABELS);
    expect(applyChipPolicy('confirm', null, [])).toEqual([]);
    const shortcut = [{ label: 'Looks right', value: 'yes' }];
    expect(applyChipPolicy('confirm', null, shortcut)).toBe(shortcut);
  });
});

describe('enforceGuardrails — chip policy wiring', () => {
  it('a distance ask ships distance chips even when the model sent none', () => {
    const r = enforceGuardrails(
      stateWith({}),
      out({ next_action: 'ask', asked_slot: 'goal_distance' }),
    );
    expect(r.chips.map((c) => c.value)).toEqual(['5k', '10k', 'half', 'marathon']);
  });

  it('an injury ask ships the single Nothing-right-now chip', () => {
    const r = enforceGuardrails(
      stateWith({}),
      out({ next_action: 'ask', asked_slot: 'injury_status', message: 'any injuries?' }),
    );
    expect(r.chips.map((c) => c.label)).toEqual(['Nothing right now']);
  });

  it('an open-slot ask stays chip-less', () => {
    const r = enforceGuardrails(
      stateWith({}, { optional_budget_remaining: 8 }),
      out({ next_action: 'ask', asked_slot: 'schedule_constraints' }),
    );
    expect(r.chips).toEqual([]);
  });

  it('a confirm turn carries no forced chips (the model chooses)', () => {
    const r = enforceGuardrails(
      stateWith(coreSlots('race')),
      out({ next_action: 'confirm', message: 'right?' }),
    );
    expect(r.chips).toEqual([]);
  });

  it('a generate override forced to ask a missing distance ships distance chips', () => {
    const slots = coreSlots('race');
    delete slots.goal_distance;
    const r = enforceGuardrails(stateWith(slots), out({ next_action: 'generate' }));
    expect(r.action).toBe('ask');
    expect(r.chips.map((c) => c.value)).toEqual(['5k', '10k', 'half', 'marathon']);
  });

  it('a generate override forced to ask a missing experience ships tappable tier chips', () => {
    // The loop-breaker: even when experience_tier is stranded open, the re-ask
    // carries enum-literal chips so a tap supplies a valid value (§5 fix).
    const slots = coreSlots('race');
    delete slots.experience_tier;
    const r = enforceGuardrails(stateWith(slots), out({ next_action: 'generate' }));
    expect(r.action).toBe('ask');
    expect(r.chips.map((c) => c.value)).toEqual([
      'beginner',
      'for_fun',
      'some_training',
      'experienced',
    ]);
  });

  it('a generate override forced to recap (injury unanswered) gets yes-no chips', () => {
    const r = enforceGuardrails(stateWith(coreSlots('race')), out({ next_action: 'generate' }));
    expect(r.action).toBe('recap');
    expect(r.chips.map((c) => c.label)).toEqual(YES_FIX_LABELS);
  });

  it('a budget-exhausted recap gets yes-no chips', () => {
    const slots = { ...coreSlots('race'), injury_status: sv('none') };
    const r = enforceGuardrails(
      stateWith(slots, { optional_budget_remaining: 0 }),
      out({ next_action: 'ask', asked_slot: 'age' }),
    );
    expect(r.action).toBe('recap');
    expect(r.chips.map((c) => c.label)).toEqual(YES_FIX_LABELS);
  });
});

describe('chip registry — round-trip safety', () => {
  it('keeps every chip value within the 60-char callback_data budget', () => {
    const all = [...Object.values(SLOT_CHIPS).flat(), ...INJURY_CHIPS];
    for (const c of all) expect(c.value.length).toBeLessThanOrEqual(60);
  });

  // The opener (goal_type) chips are model-interpreted free text, not enum
  // literals — both taps replay through extract_and_advance like a typed answer
  // (there is no "adventure" goal_type literal; the adventure tap rides the
  // event_kind path). So coercer-safety is the contract only for the enum-literal
  // sets, where the model may echo the value straight back to the coercer.
  const MODEL_INTERPRETED: ReadonlySet<SlotKey> = new Set<SlotKey>(['goal_type']);

  it('uses coercer-safe values for enum-literal slots', () => {
    for (const [slot, chips] of Object.entries(SLOT_CHIPS)) {
      if (MODEL_INTERPRETED.has(slot as SlotKey)) continue;
      for (const c of chips ?? []) {
        expect(coerceFill(slot as SlotKey, c.value)).toBe(c.value);
      }
    }
  });
});

// --- R1 fix 3: the past-goal_date guard + human-readable dates ---

describe('formatSlotValue — goal_date rendering (R1 fix 3)', () => {
  it('renders an ISO date human-readable, year visible', () => {
    expect(formatSlotValue('goal_date', '2026-09-01')).toBe('Sep 1, 2026');
    expect(formatSlotValue('goal_date', '2025-09-01')).toBe('Sep 1, 2025'); // a wrong year is now visible
  });

  it('passes a non-ISO value through untouched', () => {
    expect(formatSlotValue('goal_date', 'September-ish')).toBe('September-ish');
  });
});

describe('enforceGuardrails — past goal_date guard (R1 fix 3)', () => {
  const TODAY = { todayISO: '2026-06-10' };

  it('resets a past goal_date fill to unknown and re-asks ("September or later" → 2025-09-01)', () => {
    const slots = { ...coreSlots('race'), injury_status: sv('none') };
    const r = enforceGuardrails(
      stateWith(slots),
      out({ next_action: 'generate', fills: [fill('goal_date', '2025-09-01', 'inferred')] }),
      TODAY,
    );
    expect(r.state.slots.goal_date!.value).toBeNull();
    expect(r.state.slots.goal_date!.provenance).toBe('unknown');
    expect(r.action).toBe('ask'); // goal_date is required-core for a race goal
    expect(r.message).toMatch(/race date/i);
  });

  it('clears a past goal_date already sitting in state, not just a fresh fill', () => {
    const slots = { ...coreSlots('race'), goal_date: sv('2025-09-01'), injury_status: sv('none') };
    const r = enforceGuardrails(stateWith(slots), out({ next_action: 'generate' }), TODAY);
    expect(r.state.slots.goal_date!.provenance).toBe('unknown');
  });

  it('leaves a future date and a non-ISO placeholder alone', () => {
    const future = enforceGuardrails(
      stateWith({ ...coreSlots('race'), injury_status: sv('none') }),
      out({ next_action: 'generate' }),
      TODAY,
    );
    expect(future.state.slots.goal_date!.value).toBe('2026-11-01');

    const placeholder = enforceGuardrails(
      stateWith({ ...coreSlots('race'), goal_date: sv('September or later') }),
      out({ next_action: 'ask', asked_slot: 'injury_status' }),
      TODAY,
    );
    expect(placeholder.state.slots.goal_date!.value).toBe('September or later');
  });

  it('renders the date human-readable in a deterministic confirm', () => {
    const slots = {
      ...coreSlots('race'),
      goal_date: sv('2026-09-01', 'inferred', false),
      injury_status: sv('none'),
    };
    const r = enforceGuardrails(stateWith(slots), out({ next_action: 'generate' }), TODAY);
    expect(r.action).toBe('confirm');
    expect(r.message).toContain('Sep 1, 2026');
    expect(r.message).not.toContain('2026-09-01');
  });
});

// --- R1 fix 2: the recap bulk-confirm ---

// The Nathan fill shape at recap time: distance settled, the Strava-inferred and
// model-inferred slots all unconfirmed — the state that produced five serial
// "Quick check" turns after an affirmed recap.
function nathanSlots(): SlotState {
  return {
    goal_type: sv('race'),
    goal_distance: sv('5k', 'stated', true),
    goal_date: sv('2026-09-01', 'inferred', false),
    experience_tier: sv('experienced', 'inferred', false),
    days_per_week: sv(3, 'inferred', false),
    long_run_day: sv(3, 'inferred', false),
    injury_status: sv('past'),
    target_time: sv(300, 'inferred', false),
  };
}

describe('enforceGuardrails — recap_shown bookkeeping (R1 fix 2)', () => {
  it('records the displayed pairs when the gate forces a recap', () => {
    const r = enforceGuardrails(stateWith(coreSlots('race')), out({ next_action: 'generate' }), {
      todayISO: '2026-06-10',
    });
    expect(r.action).toBe('recap');
    expect(r.state.recap_shown).toContainEqual({ slot: 'goal_distance', value: 'marathon' });
    expect(r.state.recap_shown).toContainEqual({ slot: 'days_per_week', value: 4 });
    expect(r.state.recap_shown).toContainEqual({ slot: 'goal_date', value: '2026-11-01' });
  });

  it('records on a model-authored recap too (no buildRecapMessage call)', () => {
    const r = enforceGuardrails(
      stateWith(coreSlots('race')),
      out({ next_action: 'recap', message: 'here is what I have…' }),
    );
    expect(r.state.recap_shown?.length).toBeGreaterThan(0);
  });

  it('clears the snapshot on any non-recap resolution', () => {
    const r = enforceGuardrails(
      stateWith(coreSlots('race'), { recap_shown: [{ slot: 'days_per_week', value: 4 }] }),
      out({ next_action: 'ask', asked_slot: 'age' }),
    );
    expect(r.state.recap_shown).toBeUndefined();
  });
});

describe('enforceGuardrails — recap bulk-confirm (R1 fix 2, the Nathan regression)', () => {
  const TODAY = { todayISO: '2026-06-10' };

  it('an affirmed recap confirms every displayed slot — zero Quick-check turns', () => {
    const slots = nathanSlots();
    const shown = recapDisplayedSlots(stateWith(slots));
    const r = enforceGuardrails(
      stateWith(slots, { phase: 'recap', recap_shown: shown }),
      out({ next_action: 'generate', message: 'building it' }),
      TODAY,
    );
    expect(r.action).toBe('generate');
    expect(r.overridden).toBe(false);
    for (const k of [
      'goal_date',
      'experience_tier',
      'days_per_week',
      'long_run_day',
      'target_time',
    ] as const) {
      expect(r.state.slots[k]!.confirmed).toBe(true);
      expect(r.state.slots[k]!.provenance).toBe('stated');
    }
    expect(r.state.recap_shown).toBeUndefined(); // consumed
  });

  it('a slot corrected in the same turn is excluded — one legitimate confirm, not five', () => {
    const slots = nathanSlots();
    const shown = recapDisplayedSlots(stateWith(slots));
    const r = enforceGuardrails(
      stateWith(slots, { phase: 'recap', recap_shown: shown }),
      out({
        next_action: 'generate',
        fills: [fill('days_per_week', 4, 'inferred')], // "actually 4 days" mid-affirmation
      }),
      TODAY,
    );
    expect(r.action).toBe('confirm');
    expect(r.state.pending_confirm?.slot).toBe('days_per_week');
    // the untouched displayed slots were still bulk-confirmed
    expect(r.state.slots.goal_date!.confirmed).toBe(true);
    expect(r.state.slots.experience_tier!.confirmed).toBe(true);
  });

  it('an affirmed recap with the injury beat open asks the injury question, not a second recap', () => {
    const slots = nathanSlots();
    delete slots.injury_status;
    const shown = recapDisplayedSlots(stateWith(slots));
    const r = enforceGuardrails(
      stateWith(slots, { phase: 'recap', recap_shown: shown }),
      out({ next_action: 'generate' }),
      TODAY,
    );
    expect(r.action).toBe('ask');
    expect(r.message).toMatch(/anything bothering you/i);
    expect(r.chips.map((c) => c.label)).toEqual(['Nothing right now']);
    expect(r.state.asked).toContain('injury_status'); // recorded so a dodge can't re-loop
    expect(r.state.recap_shown).toBeUndefined();
  });

  it('no bulk-confirm without a preceding recap (a plain generate turn)', () => {
    const slots = nathanSlots();
    const r = enforceGuardrails(stateWith(slots), out({ next_action: 'generate' }), TODAY);
    expect(r.action).toBe('confirm'); // the normal gate walk — recap_shown was never set
  });
});

describe('resolveRecapAffirmAndAdvance — the chip fast path (R1 fix 2)', () => {
  it('a "Looks right" tap resolves straight to generate with everything confirmed', () => {
    const slots = nathanSlots();
    const shown = recapDisplayedSlots(stateWith(slots));
    const r = resolveRecapAffirmAndAdvance(
      stateWith(slots, { phase: 'recap', recap_shown: shown }),
    );
    expect(r.action).toBe('generate');
    expect(r.state.slots.days_per_week!.confirmed).toBe(true);
    expect(r.state.pending_confirm).toBeUndefined();
  });
});

describe('recapDisplayedSlots — mirrors what the recap shows', () => {
  it('includes only displayed slots and skips an open (unanswered) injury', () => {
    const slots: SlotState = { ...nathanSlots() };
    delete slots.injury_status; // dodged/open — the recap shows nothing for it
    const shown = recapDisplayedSlots(stateWith(slots));
    const keys = shown.map((s) => s.slot);
    expect(keys).not.toContain('injury_status');
    expect(keys).toContain('goal_distance');
    expect(keys).toContain('target_time');
  });

  it('in the accepted-pocket case records the displayed proxy, not the race line', () => {
    const slots: SlotState = {
      ...coreSlots('race'),
      goal_race: sv('Rae Lakes Loop'),
      injury_status: sv('none'),
    };
    const shown = recapDisplayedSlots(
      stateWith(slots, {
        out_of_catalog: {
          words: 'Rae Lakes Loop',
          distance_mi: 44,
          proxy: 'marathon',
          consent: 'accepted',
        },
      }),
    );
    const keys = shown.map((s) => s.slot);
    expect(keys).toContain('goal_distance'); // the proxy is what the recap displays
    expect(keys).not.toContain('goal_race'); // the ooc goal line replaces the race line
  });
});

// ---------------------------------------------------------------------------
// R2 — intents + the reflection flip (ONBOARDING_REFLECTION §2)
// ---------------------------------------------------------------------------

describe('mergeIntents (R2)', () => {
  it('appends new intents and is the identity on an empty delta', () => {
    expect(mergeIntents(undefined, ['speed at shorter distances'])).toEqual([
      'speed at shorter distances',
    ]);
    expect(mergeIntents(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('dedupes case-insensitively and drops blank entries', () => {
    expect(mergeIntents(['Build strength'], ['build strength', '  ', 'stay healthy'])).toEqual([
      'Build strength',
      'stay healthy',
    ]);
  });

  it('caps at INTENTS_CAP with newest winning', () => {
    const five = ['a', 'b', 'c', 'd', 'e'];
    expect(mergeIntents(five, ['f'])).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(five.length).toBe(INTENTS_CAP);
  });
});

describe('hasReflected (R2) — the grandfather rule', () => {
  it('honors an explicit flag in either direction', () => {
    expect(hasReflected(stateWith({}, { reflected: true }))).toBe(true);
    // explicit false wins even with goal slots filled (the redo path clears the
    // slots, but a race-lookup redo can refill them the same turn)
    expect(hasReflected(stateWith(coreSlots('race'), { reflected: false }))).toBe(false);
  });

  it('grandfathers a pre-R2 state that already carries goal content', () => {
    expect(hasReflected(stateWith(coreSlots('race')))).toBe(true);
    expect(hasReflected(stateWith({ goal_race: sv('CIM') }))).toBe(true);
  });

  it('a fresh state with no goal content is unreflected', () => {
    expect(hasReflected(stateWith({}))).toBe(false);
    expect(hasReflected(stateWith({ days_per_week: sv(4) }))).toBe(false);
  });
});

describe('enforceGuardrails — intents merge + reflected flip (R2)', () => {
  it('merges the model intents into state and flips reflected on a goal fill', () => {
    const r = enforceGuardrails(
      stateWith({}),
      out({
        fills: [fill('goal_type', 'race')],
        intents: ['speed at shorter distances', 'build muscle strength'],
      }),
    );
    expect(r.state.intents).toEqual(['speed at shorter distances', 'build muscle strength']);
    expect(r.state.reflected).toBe(true);
  });

  it.each([
    ['goal_distance_mi', out({ goal_distance_mi: 1 })],
    ['race_lookup_query', out({ race_lookup_query: 'CIM' })],
    ['a new intent alone', out({ intents: ['get stronger'] })],
  ])('flips reflected on %s', (_label, output) => {
    const r = enforceGuardrails(stateWith({}), output);
    expect(r.state.reflected).toBe(true);
  });

  it('does not flip on a non-goal-bearing turn (and a duplicate intent is not "new")', () => {
    const dupOnly = enforceGuardrails(
      stateWith({ days_per_week: sv(4) }, { reflected: false, intents: ['get stronger'] }),
      out({ fills: [fill('long_run_day', 0)], intents: ['Get Stronger'] }),
    );
    expect(dupOnly.state.reflected).toBe(false);
    expect(dupOnly.state.intents).toEqual(['get stronger']);
  });

  it('flips even when the turn is overridden — the router composes the mirror onto the override', () => {
    const r = enforceGuardrails(
      stateWith({}),
      out({
        next_action: 'generate', // open required slots → overridden to ask
        fills: [fill('goal_type', 'race')],
        reflection: 'Here is what I am hearing',
      }),
    );
    expect(r.overridden).toBe(true);
    expect(r.state.reflected).toBe(true);
  });

  it('synthetic turns can neither append intents nor count as goal-bearing', () => {
    const slots = coreSlots('race');
    const before = stateWith(slots, {
      intents: ['stay durable'],
      pending_confirm: { slot: 'days_per_week', value: 4, attempts: 1 },
    });
    const r = resolveConfirmAndAdvance(before);
    expect(r.state.intents).toEqual(['stay durable']);

    const recapState = stateWith(slots, {
      intents: ['stay durable'],
      recap_shown: recapDisplayedSlots(stateWith(slots)),
    });
    const r2 = resolveRecapAffirmAndAdvance(recapState);
    expect(r2.state.intents).toEqual(['stay durable']);
  });
});

describe('buildRecapMessage — the intents line (R2)', () => {
  it('renders "Also working toward" from intents', () => {
    const msg = buildRecapMessage(
      stateWith(coreSlots('race'), {
        intents: ['speed at shorter distances', 'build muscle strength'],
      }),
    );
    expect(msg).toContain(
      '• Also working toward: speed at shorter distances, build muscle strength',
    );
  });

  it('omits the line when there are no intents', () => {
    expect(buildRecapMessage(stateWith(coreSlots('race')))).not.toContain('Also working toward');
  });
});

describe('recapDisplayedSlots — unaffected by intents (R2)', () => {
  it('intents are not slots: never displayed-as-confirmable, never bulk-confirmed', () => {
    const withIntents = stateWith(coreSlots('race'), { intents: ['get faster'] });
    const without = stateWith(coreSlots('race'));
    expect(recapDisplayedSlots(withIntents)).toEqual(recapDisplayedSlots(without));
  });
});

describe('enforceGuardrails — volume_goal is goal-bearing (staging fix)', () => {
  it('a volume-only ramble flips reflected', () => {
    const r = enforceGuardrails(
      stateWith({}),
      out({ volume_goal: { miles: 100, period: 'month' } }),
    );
    expect(r.state.reflected).toBe(true);
  });

  it('synthetic turns stay inert (volume_goal: null)', () => {
    const slots = coreSlots('race');
    const r = resolveRecapAffirmAndAdvance(
      stateWith(slots, { recap_shown: recapDisplayedSlots(stateWith(slots)) }),
    );
    expect(r.state.intents).toBeUndefined();
  });
});

describe('enforceGuardrails — a pivot supersedes an ACCEPTED pocket (stale-pocket fix)', () => {
  // Chase's shape after accepting the 44-mi proxy: goal_distance holds the
  // marathon proxy, the pocket rides accepted, every other required slot filled.
  function acceptedPocketState(over: Partial<V3OnboardingState> = {}): V3OnboardingState {
    return stateWith(coreSlots('race'), {
      out_of_catalog: {
        words: '44 miles in the mountains',
        distance_mi: 44,
        proxy: 'marathon',
        consent: 'accepted',
      },
      ...over,
    });
  }

  it('a different in-catalog distance clears the pocket and demotes the words', () => {
    const r = enforceGuardrails(
      acceptedPocketState(),
      out({ fills: [fill('goal_distance', 'half')] }),
    );
    expect(r.state.out_of_catalog).toBeUndefined();
    expect(r.state.intents).toEqual(['44 miles in the mountains']);
  });

  it('a goal-race change clears it even when the new bucket EQUALS the proxy', () => {
    // The residual the distance check alone misses: 44-mi pocket → a real
    // marathon. goal_distance stays 'marathon' (= proxy); the race change is
    // the only tell.
    const r = enforceGuardrails(
      acceptedPocketState(),
      out({ fills: [fill('goal_race', 'CIM'), fill('goal_date', '2026-12-06')] }),
    );
    expect(r.state.out_of_catalog).toBeUndefined();
    expect(r.state.intents).toEqual(['44 miles in the mountains']);
  });

  it('a re-emit of the proxy is not a pivot — the pocket survives', () => {
    const r = enforceGuardrails(
      acceptedPocketState(),
      out({ fills: [fill('goal_distance', 'marathon')] }),
    );
    expect(r.state.out_of_catalog?.consent).toBe('accepted');
    expect(r.state.intents).toBeUndefined();
  });

  it('a turn that touches nothing goal-shaped leaves the pocket alone', () => {
    const r = enforceGuardrails(acceptedPocketState(), out({ fills: [fill('age', 41)] }));
    expect(r.state.out_of_catalog?.consent).toBe('accepted');
  });

  it('a PENDING pocket is not this check, by design (reconcilePocket owns it)', () => {
    const pending = acceptedPocketState();
    pending.out_of_catalog = { ...pending.out_of_catalog!, consent: 'pending' };
    const r = enforceGuardrails(pending, out({ fills: [fill('goal_distance', 'half')] }));
    expect(r.state.out_of_catalog?.consent).toBe('pending');
  });

  it('the synthetic generate path cannot trip it (state is its own baseline)', () => {
    const r = resolveRecapAffirmAndAdvance(
      acceptedPocketState({
        recap_shown: recapDisplayedSlots(acceptedPocketState()),
        slots: { ...coreSlots('race'), injury_status: sv('none') },
      }),
    );
    expect(r.state.out_of_catalog?.consent).toBe('accepted');
  });

  it('end-to-end: the pivoted state recaps the new race and commits the bucket nominal', () => {
    const r = enforceGuardrails(
      acceptedPocketState(),
      out({
        fills: [
          fill('goal_race', 'CIM'),
          fill('goal_date', '2026-12-06'),
          fill('goal_distance', 'marathon'),
        ],
      }),
    );
    // Recap: the new race owns the goal line; the old goal rides as an intent.
    const recap = buildRecapMessage(r.state);
    expect(recap).toContain('• Race: CIM — Dec 6, 2026 (marathon)');
    expect(recap).not.toMatch(/• Goal: 44 miles in the mountains/);
    expect(recap).toContain('• Also working toward: 44 miles in the mountains');
    // Commit: the race row gets the marathon nominal, not the stale 44.
    const { race } = buildGoalWrite(r.state);
    expect(race!.distance_mi).toBeCloseTo(26.2, 1);
  });
});
