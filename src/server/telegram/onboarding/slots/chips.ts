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

/** Canonical tap sets keyed by the slot being asked. The load-bearing sets:
 *  goal_type (the v4 event-led opener — a race or a dated personal goal, never a
 *  stay-fit tap), goal_distance (the closed distance list), and the injury beat
 *  (INJURY_CHIPS, below). The Strava-inferred slots (experience / days /
 *  long-run) are confirmed via one batch yes/no in Opener 2; their option chips
 *  only matter on a rare "Fix it" re-ask and want multi-column rendering, so
 *  they're deferred (see the W4 plan's flagged follow-ups). */
export const SLOT_CHIPS: Partial<Record<SlotKey, readonly Chip[]>> = {
  // Onboarding v4 (§4.2 / §8): the opener is event-led. Both taps point at a
  // dated effort; there is NO "staying fit" chip — Daybreak is built around
  // training for something, and a no-event athlete self-selects the off-ramp by
  // typing it (router's no-event off-ramp catches goal_type=general_fitness),
  // never by tapping an option the product advertises as coequal. Values are
  // plain text replayed through extract_and_advance: "a race" → goal_type=race;
  // the adventure tap pushes the model onto the event_kind=adventure path so it
  // asks for the effort's distance + date.
  goal_type: [
    { label: 'A race', value: 'a race' },
    { label: 'Personal goal with a date', value: 'my own dated goal, not an official race' },
  ],
  goal_distance: [
    { label: '5K', value: '5k' },
    { label: '10K', value: '10k' },
    { label: 'Half', value: 'half' },
    { label: 'Marathon', value: 'marathon' },
  ],
  // The enum literal is the chip value so it round-trips cleanly through
  // coerceFill; this also guarantees a tappable escape if the model ever fails
  // to map a prose answer onto the enum (the §5 "intermediate" loop).
  experience_tier: [
    { label: 'New to running', value: 'beginner' },
    { label: 'Run for fun', value: 'for_fun' },
    { label: 'Some training', value: 'some_training' },
    { label: 'Experienced', value: 'experienced' },
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
