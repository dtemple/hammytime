// Onboarding v3 (V3-W4): canonical chip sets for closed-option slots.
//
// Principle 2 (ONBOARDING_V3 §2): any question with a small, discrete answer set
// always ships chips, and a tap or the equivalent typed text fills the same slot.
// W1/W2 already converge taps and typed text on one extraction path; this registry
// makes the *guarantee* deterministic — the chips for a closed-option ask come from
// code (§5.4), not the model's discretion.
//
// A tapped chip's `value` is replayed as the athlete's text back through
// extract_and_advance (router.handleV3Callback). So every value must:
//   1. be ≤60 chars — chipsKeyboard slices callback_data to 60 (router.ts);
//   2. round-trip cleanly — the model re-reads it and the coercer in
//      guardrails.coerceFill accepts the resulting fill. For enum slots the
//      cleanest value is the enum literal the coercer already takes.

import type { Chip } from '../engine/extract-and-advance';
import type { SlotKey } from './schema';

/** Canonical tap sets keyed by the slot being asked. W4 ships the load-bearing
 *  pair: goal_distance (the closed list that fails today) and the injury beat
 *  (INJURY_CHIPS, below). The Strava-inferred slots (experience / days /
 *  long-run) are confirmed via one batch yes/no in Opener 2; their option chips
 *  only matter on a rare "Fix it" re-ask and want multi-column rendering, so
 *  they're deferred (see the W4 plan's flagged follow-ups). */
export const SLOT_CHIPS: Partial<Record<SlotKey, readonly Chip[]>> = {
  goal_distance: [
    { label: '5K', value: '5k' },
    { label: '10K', value: '10k' },
    { label: 'Half', value: 'half' },
    { label: 'Marathon', value: 'marathon' },
  ],
};

/** The injury beat's chips. Kept separate because the set carries the safety
 *  semantics of the gate, not just a list of options: `[Nothing right now]` is
 *  the explicit "stated none" the gate needs, and `[Skip]` leaves injury_status
 *  `unknown` (mergeFills coerces a non-stated `none`→`unknown` as a backstop).
 *  Per David's W4 call these render only when the model chooses to ask the beat —
 *  nothing forces them or drives the question. */
export const INJURY_CHIPS: readonly Chip[] = [
  { label: 'Nothing right now', value: 'nothing bothering me right now' },
  { label: 'Skip', value: 'skip this for now' },
];
