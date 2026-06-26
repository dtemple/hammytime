// Phase 0 (V4 §9 "convert"): a no-event athlete must hit the entry off-ramp —
// NOT a keep_fit plan. enterDormant fires, generateAndPersistPlan does not, no
// goal_distance bucket is written.

import type { OnboardingFixture } from '../../types';
import { casualSnapshot } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'general-fitness-offramp',
  persona: 'Jordan — easygoing, not training for anything, just wants to stay in shape. No race, now or later.',
  facts: {
    goal: 'stay fit and healthy, run a few times a week',
    race: 'none — not interested in racing',
    event: 'no event, no date, not now and not later',
    runs_per_week: 3,
    injuries: 'none',
  },
  opening: "Honestly I just want to stay fit. No races or anything, just keep moving.",
  initialState: { strava_snapshot: casualSnapshot() },
  expect: {
    offRamp: true,
    planGenerated: false,
    noBucketWritten: true,
  },
  customAssertions: (r) => {
    // No keep_fit plan path was taken, and the off-ramp went dormant.
    if (r.ports.enterDormant.length === 0)
      throw new Error('expected enterDormant to be called on the no-event off-ramp');
    if (r.finalState.slots.goal_distance?.value === 'keep_fit')
      throw new Error('a keep_fit bucket was written — the retired keep_fit path leaked');
  },
};
