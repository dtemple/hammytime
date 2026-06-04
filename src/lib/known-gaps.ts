// Known gaps — fields onboarding v2 deliberately does NOT collect up front.
//
// Onboarding v2 keeps the structured core short (goal, experience, distance,
// days/week, long-run day, injury yes/no). Everything nice-to-have is recorded
// as a "known gap" the daily coach fills opportunistically — at the moment the
// answer changes a prescription, not at random. See Specs/ONBOARDING_V2.md
// (Phase C dump + the cross-cutting "deferred-gap collection" section, W5).
//
// This module defines the *catalog* and *types* only. Persistence (where an
// athlete's gap state lives) and the fill loop (the daily coach asking, writing
// back, clearing) are W5. W3 references this so plan generation can degrade
// safely while a gap is open — e.g. strength stays bodyweight until
// `strength_equipment` is known.

export type KnownGapKey =
  | 'age'
  | 'target_time'
  | 'tune_up_races'
  | 'recent_long_run'
  | 'strength_equipment'
  | 'schedule_constraints';

/** Strength-equipment access. Drives how far past bodyweight the strength
 *  prescription can go. `unknown` is the default until the gap is filled, and
 *  maps to a bodyweight-only prescription. */
export type StrengthEquipment = 'gym' | 'free_weights' | 'bodyweight_only' | 'unknown';

export interface KnownGapDef {
  key: KnownGapKey;
  /** What's missing, in one line. */
  what: string;
  /** When it becomes worth asking — the moment the answer changes a prescription. */
  paysOffWhen: string;
  /** How to ask it, in Daybreak voice — used by the /edit_profile "Finish my
   *  profile" walk (onboarding v3 W3) when the athlete pulls a gap forward. */
  question: string;
  /** Discrete answer set when the ask is a button rather than free text; else omitted. */
  options?: readonly string[];
}

export const KNOWN_GAPS: Record<KnownGapKey, KnownGapDef> = {
  age: {
    key: 'age',
    what: "The athlete's age.",
    paysOffWhen:
      'Setting HR zones or recovery spacing precisely, or when a masters-specific adjustment would change a session.',
    question: 'How old are you? It helps me get your effort zones and recovery right.',
  },
  target_time: {
    key: 'target_time',
    what: 'A finish-time goal for the race (vs. just finishing).',
    paysOffWhen:
      'The first goal-pace session — a time goal turns effort-led paces into concrete pace targets.',
    question: 'Do you have a time goal in mind, or is finishing strong the goal for now?',
  },
  tune_up_races: {
    key: 'tune_up_races',
    what: 'Tune-up races before the goal race.',
    paysOffWhen:
      'Planning the build/peak — a tune-up becomes a mini-taper + hard effort that reshapes the surrounding weeks.',
    question: 'Any tune-up races on the calendar before the main one?',
  },
  recent_long_run: {
    key: 'recent_long_run',
    what: "The athlete's most recent long-run distance, if Strava is thin or missing.",
    paysOffWhen: 'Anchoring the starting long run when the Strava snapshot has no usable signal.',
    question: "What's the longest run you've done in the last few weeks?",
  },
  strength_equipment: {
    key: 'strength_equipment',
    what: 'What strength-training equipment the athlete can access.',
    paysOffWhen:
      'Before upgrading strength past bodyweight — the first time a loaded movement (weighted lunges, deadlifts, etc.) would otherwise be prescribed. Until then the plan uses bodyweight-only sessions.',
    question:
      'For strength work, what do you have — a gym, some weights at home, or just bodyweight?',
    options: ['gym', 'free_weights', 'bodyweight_only', 'unsure'] as const,
  },
  schedule_constraints: {
    key: 'schedule_constraints',
    what: 'Recurring schedule constraints (travel, fixed commitments, preferred run times).',
    paysOffWhen:
      'Slotting hard days and the long run around a week the athlete has already told us is constrained.',
    question:
      'Anything in your week I should plan around — travel, fixed days, when you like to run?',
  },
};

/** A gap's live state on an athlete. W5 owns where this is stored; the shape is
 *  defined here so W3 can read "is this gap still open?" when generating a plan. */
export interface KnownGapState {
  key: KnownGapKey;
  status: 'unknown' | 'filled';
  value?: string; // free text, or one of KnownGapDef.options
  filledAt?: string; // ISO timestamp
}

/** Map the filled `strength_equipment` answer onto the typed value the strength
 *  model reads. Anything unrecognized / unfilled stays `unknown` → bodyweight. */
export function asStrengthEquipment(value: string | undefined): StrengthEquipment {
  switch (value) {
    case 'gym':
      return 'gym';
    case 'free_weights':
      return 'free_weights';
    case 'bodyweight_only':
      return 'bodyweight_only';
    default:
      return 'unknown';
  }
}
