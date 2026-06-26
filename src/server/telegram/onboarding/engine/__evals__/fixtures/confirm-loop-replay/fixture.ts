// V3 §7 keep-verbatim: the confirm-loop replay. An athlete whose shape slots arrive
// inferred-from-Strava and who affirms the stated-back confirm — the same
// deterministic confirm must never be sent more than twice (the 2026-06-05 fix that
// killed the seven-times "days per week" loop).
//
// knownFlaky: faithfully reproducing the exact confirm sequence is model-shaped and
// best validated against a live run. The deterministic proxy here counts how often
// the coach re-asks the historically-looping slot; a true replay can be pinned with
// forcedMoves once a live run shows the real phrasing.

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'confirm-loop-replay',
  persona:
    'Nat — agreeable. When the coach states back the Strava-inferred training shape ("looks like ~4 days/week, long runs Sunday…"), confirms it ("yep, that\'s right") and does not contradict it later.',
  facts: {
    goal: 'the Ridgeline Marathon in November',
    race: 'Ridgeline Marathon',
    date: '2026-11-08',
    distance: 'marathon',
    experience: 'experienced — years of training',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'none',
  },
  opening: "Training for the Ridgeline Marathon in November",
  // Inferred, unconfirmed shape slots — the shape that produced the loop.
  initialState: {
    strava_snapshot: enduranceSnapshot(),
    slots: {
      days_per_week: { value: 4, provenance: 'inferred', confirmed: false },
      long_run_day: { value: 0, provenance: 'inferred', confirmed: false },
      experience_tier: { value: 'experienced', provenance: 'inferred', confirmed: false },
    },
  },
  raceLookup: { ridgeline: found('Ridgeline Marathon', '2026-11-08', 26.2) },
  knownFlaky: 'exact confirm phrasing is model-shaped; deterministic replay needs a live run to pin',
  expect: { planGenerated: true, goalDistance: 'marathon' },
  customAssertions: (r) => {
    // The historically-looping slot must not be re-asked more than twice.
    const daysAsks = r.transcript.filter(
      (t) => t.direction === 'coach' && /days?\s*(\/|per|a)\s*week/i.test(t.body),
    ).length;
    if (daysAsks > 2)
      throw new Error(`the days/week confirm was sent ${daysAsks} times (>2 — the loop regressed)`);
  },
};
