// Onboarding v3 (V3-W1): the global slot catalog.
//
// One schema, filled across the whole conversation (ONBOARDING_V3 §3). Each slot
// carries metadata that drives engine behavior: `class` gates plan generation,
// `confirmPolicy` decides whether a fill is echoed, `planDriving`/`safety` flag
// the guardrails (§5.4), and `numeric` carries the plausibility bounds the
// deterministic unit/sanity layer reads (§5.1) so that logic stays data-driven
// instead of hardcoded.
//
// This module is metadata + pure helpers only. The per-turn engine, the
// extraction tool, and the guardrail enforcement are W2; the openers, confirms,
// and slot→column writes are W3.

import type { KnownGapKey } from '@/lib/known-gaps';
import { formatFinishTime } from '../parsing/durations';
import type { SlotValue } from './provenance';

// ---------------------------------------------------------------------------
// Slot value types
//
// Literal unions mirroring the athlete_training_profile CHECK constraints (the
// generated DB types collapse these columns to `string`, so the constraints in
// 20260601000000_athlete_training_profile.sql are the real source of truth). The
// slot→column write (W3) maps these v3-meaningful values onto the stored enum —
// notably `general_fitness` persists as goal_type='day_to_day' + goal_distance=
// 'keep_fit' against the current schema (see ONBOARDING_V3 §3 / decision #8 and
// the plan's flag #9).
// ---------------------------------------------------------------------------

export type GoalTypeValue = 'race' | 'general_fitness';
export type ExperienceTierValue = 'beginner' | 'for_fun' | 'some_training' | 'experienced';
export type GoalDistanceValue = '5k' | '10k' | 'half' | 'marathon' | 'keep_fit';
export type InjuryStatusValue = 'none' | 'active' | 'monitoring' | 'past' | 'unknown';

/** A described injury: the part and how live it is. `past` maps to the
 *  `injuries.status` value 'resolved' at write time (W3). */
export interface InjuryDetail {
  body_part: string;
  status: 'active' | 'monitoring' | 'past';
}

export interface TuneUpRace {
  name: string;
  date: string | null; // ISO YYYY-MM-DD
}

/** The value type stored for each slot. The state's `slots` map is
 *  `{ [K in SlotKey]?: SlotValue<SlotValueTypes[K]> }`. */
export interface SlotValueTypes {
  name: string;
  sex: string;
  timezone: string;
  goal_type: GoalTypeValue;
  experience_tier: ExperienceTierValue;
  goal_distance: GoalDistanceValue;
  goal_race: string; // canonical race name (from lookupRace)
  goal_date: string; // ISO YYYY-MM-DD (real date, or an intended-branch placeholder)
  days_per_week: number; // 3–7
  long_run_day: number; // 0=Sun..6=Sat
  injury_status: InjuryStatusValue;
  injury_detail: InjuryDetail;
  age: number;
  target_time: number; // finish-time goal in seconds
  tune_up_races: TuneUpRace[];
  schedule_constraints: string;
  strength_equipment: string;
  motivation: string;
}

export type SlotKey = keyof SlotValueTypes;

export type SlotValueFor<K extends SlotKey> = SlotValue<SlotValueTypes[K]>;

/** The live slot map carried in V3OnboardingState. */
export type SlotState = { [K in SlotKey]?: SlotValueFor<K> };

// ---------------------------------------------------------------------------
// Slot metadata
// ---------------------------------------------------------------------------

export type SlotClass =
  | 'derived' // filled from Strava, not asked
  | 'required-core' // gates plan generation
  | 'required-safety' // the injury beat — always asked
  | 'safety-light' // injury detail — confirmed when present
  | 'optional-deferred' // nice-to-have; leftover → known_gap
  | 'optional'; // nice-to-have; no gap

export type SlotSource = 'strava' | 'asked' | 'extracted' | 'lookup';

export type ConfirmPolicy =
  | 'silent' // written without an echo
  | 'confirm-once' // confirmed a single time (name, at A1)
  | 'implicit' // confirmed by context, not its own turn
  | 'inline' // echoed for confirmation at the moment it's filled
  | 'gate' // the injury beat: asked, soft-gates, not a hard block
  | 'none-to-gap' // unconfirmed; leftover seeds a known_gap
  | 'none'; // unconfirmed, untracked

export interface NumericSpec {
  unit: 'seconds' | 'years';
  /** Coarse outer envelope for the deterministic plausibility layer (§5.1).
   *  Distance-specific finish-time bounds live in FINISH_TIME_RANGES_SEC. */
  plausibleRange: { min: number; max: number };
}

export interface SlotDef {
  key: SlotKey;
  class: SlotClass;
  source: SlotSource;
  confirmPolicy: ConfirmPolicy;
  /** Drives template selection / paces — confirmed before use, and never
   *  written from an inferred value without a confirm turn (§5.4). */
  planDriving: boolean;
  /** Safety-relevant — governs the injury invariants (§2.4). */
  safety: boolean;
  /** Only meaningful against a dated race; dropped from the gate for a
   *  general-fitness athlete and suppressed by the non-race coach branch (W7). */
  raceOnly?: boolean;
  numeric?: NumericSpec;
  knownGapKey?: KnownGapKey;
}

/** Plausible finish-time windows per distance, in seconds. The §5.1 layer uses
 *  these to resolve unit ambiguity ("4:25" for a marathon is hours, not minutes,
 *  because four minutes is out of range) and to sanity-check a stated goal. No
 *  entry for `keep_fit` — a no-race athlete has no finish-time goal. */
export const FINISH_TIME_RANGES_SEC: Partial<
  Record<GoalDistanceValue, { min: number; max: number }>
> = {
  '5k': { min: 12 * 60, max: 60 * 60 }, // 12:00 – 1:00:00
  '10k': { min: 25 * 60, max: 105 * 60 }, // 25:00 – 1:45:00
  half: { min: 55 * 60, max: 4 * 3600 }, // 55:00 – 4:00:00
  marathon: { min: 2 * 3600, max: 7.5 * 3600 }, // 2:00:00 – 7:30:00
};

export const SLOTS: Record<SlotKey, SlotDef> = {
  // --- Derived from Strava (ONBOARDING_V3 §3) ---
  name: {
    key: 'name',
    class: 'derived',
    source: 'strava',
    confirmPolicy: 'confirm-once',
    planDriving: false,
    safety: false,
  },
  sex: {
    key: 'sex',
    class: 'derived',
    source: 'strava',
    confirmPolicy: 'silent',
    planDriving: false,
    safety: false,
  },
  timezone: {
    key: 'timezone',
    class: 'derived',
    source: 'strava',
    confirmPolicy: 'silent',
    planDriving: false,
    safety: false,
  },

  // --- Required core ---
  goal_type: {
    key: 'goal_type',
    class: 'required-core',
    source: 'asked',
    confirmPolicy: 'implicit',
    planDriving: true,
    safety: false,
  },
  experience_tier: {
    key: 'experience_tier',
    class: 'required-core',
    source: 'strava',
    confirmPolicy: 'inline',
    planDriving: true,
    safety: false,
  },
  goal_distance: {
    key: 'goal_distance',
    class: 'required-core',
    source: 'asked',
    confirmPolicy: 'inline',
    planDriving: true,
    safety: false,
  },
  goal_race: {
    key: 'goal_race',
    class: 'required-core',
    source: 'lookup',
    confirmPolicy: 'inline',
    planDriving: true,
    safety: false,
    raceOnly: true,
  },
  goal_date: {
    key: 'goal_date',
    class: 'required-core',
    source: 'lookup',
    confirmPolicy: 'inline',
    planDriving: true,
    safety: false,
    raceOnly: true,
  },
  days_per_week: {
    key: 'days_per_week',
    class: 'required-core',
    source: 'strava',
    confirmPolicy: 'inline',
    planDriving: true,
    safety: false,
  },
  long_run_day: {
    key: 'long_run_day',
    class: 'required-core',
    source: 'strava',
    confirmPolicy: 'inline',
    planDriving: true,
    safety: false,
  },

  // --- Safety ---
  injury_status: {
    key: 'injury_status',
    class: 'required-safety',
    source: 'asked',
    confirmPolicy: 'gate',
    planDriving: false,
    safety: true,
  },
  injury_detail: {
    key: 'injury_detail',
    class: 'safety-light',
    source: 'extracted',
    confirmPolicy: 'inline',
    planDriving: false,
    safety: true,
  },

  // --- Optional (extracted; leftover → known_gap) ---
  age: {
    key: 'age',
    class: 'optional-deferred',
    source: 'extracted',
    confirmPolicy: 'none-to-gap',
    planDriving: false,
    safety: false,
    numeric: { unit: 'years', plausibleRange: { min: 10, max: 100 } },
    knownGapKey: 'age',
  },
  target_time: {
    key: 'target_time',
    class: 'optional-deferred',
    source: 'extracted',
    confirmPolicy: 'inline',
    planDriving: true,
    safety: false,
    raceOnly: true,
    numeric: { unit: 'seconds', plausibleRange: { min: 10 * 60, max: 8 * 3600 } },
    knownGapKey: 'target_time',
  },
  tune_up_races: {
    key: 'tune_up_races',
    class: 'optional-deferred',
    source: 'extracted',
    confirmPolicy: 'none-to-gap',
    planDriving: false,
    safety: false,
    raceOnly: true,
    knownGapKey: 'tune_up_races',
  },
  schedule_constraints: {
    key: 'schedule_constraints',
    class: 'optional-deferred',
    source: 'extracted',
    confirmPolicy: 'none-to-gap',
    planDriving: false,
    safety: false,
    knownGapKey: 'schedule_constraints',
  },
  strength_equipment: {
    key: 'strength_equipment',
    class: 'optional-deferred',
    source: 'extracted',
    confirmPolicy: 'none-to-gap',
    planDriving: false,
    safety: false,
    knownGapKey: 'strength_equipment',
  },
  motivation: {
    key: 'motivation',
    class: 'optional',
    source: 'extracted',
    confirmPolicy: 'none',
    planDriving: false,
    safety: false,
  },
};

export const SLOT_KEYS = Object.keys(SLOTS) as SlotKey[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The slots that hard-block plan generation, given the athlete's goal type.
 *
 *  Base (every goal type): goal_type, experience_tier, goal_distance,
 *  days_per_week, long_run_day. `goal_distance` is always required — a no-race
 *  athlete's distance is the literal value `keep_fit`, which selects the
 *  base-maintenance template.
 *
 *  A `race` athlete additionally needs `goal_date` (a real date if committed, or
 *  an intended-branch placeholder — both are "filled"), but NOT `goal_race`: the
 *  intended branch lets a race-goal athlete generate before naming a specific
 *  race. A `general_fitness` athlete needs no race slot at all. */
export function requiredCoreSlots(goalType: GoalTypeValue | null): SlotKey[] {
  const base: SlotKey[] = [
    'goal_type',
    'experience_tier',
    'goal_distance',
    'days_per_week',
    'long_run_day',
  ];
  return goalType === 'race' ? [...base, 'goal_date'] : base;
}

export function safetySlots(): SlotKey[] {
  return SLOT_KEYS.filter((k) => SLOTS[k].safety);
}

export function planDrivingSlots(): SlotKey[] {
  return SLOT_KEYS.filter((k) => SLOTS[k].planDriving);
}

/** Project the filled, stated optional slots onto known-gap values. Mirrors the
 *  stated-only rule in known-gaps-memory.ts `filledFromEnrichment`: only a
 *  `stated` fill closes a gap; `inferred`/`unknown` stay open for the daily
 *  coach to confirm. Slots with no `knownGapKey` (e.g. `motivation`) and
 *  coach-only gaps with no intake slot (e.g. `recent_long_run`) are not in this
 *  projection — it is deliberately not an identity map. */
export function slotsToGaps(slots: SlotState): Partial<Record<KnownGapKey, string>> {
  const filled: Partial<Record<KnownGapKey, string>> = {};
  for (const key of SLOT_KEYS) {
    const def = SLOTS[key];
    if (!def.knownGapKey) continue;
    const slot = slots[key];
    if (!slot || slot.provenance !== 'stated' || slot.value == null) continue;
    filled[def.knownGapKey] = renderGapValue(key, slot.value);
  }
  return filled;
}

function renderGapValue(key: SlotKey, value: unknown): string {
  if (key === 'target_time' && typeof value === 'number') return formatFinishTime(value);
  if (key === 'age' && typeof value === 'number') return String(value);
  if (key === 'tune_up_races' && Array.isArray(value)) {
    return (value as TuneUpRace[])
      .map((t) => (t.date ? `${t.name} (${t.date})` : t.name))
      .join('; ');
  }
  return String(value);
}
