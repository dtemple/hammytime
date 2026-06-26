// V3 §7 keep-verbatim (converted by v4): a periodic volume target ("20 miles a
// week") is not a plan the app can build — it routes to the no-event off-ramp (not
// the pocket's proxy), and the clause rides as an intent.

import type { OnboardingFixture } from '../../types';
import { casualSnapshot } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'volume-goal',
  persona:
    'Sage — wants to hold a steady weekly mileage as the goal itself. No race, no dated effort. Pushes the volume target if asked.',
  facts: {
    goal: 'run 20 miles a week, consistently',
    race: 'none',
    event: 'no dated effort, now or later',
    weekly_mileage_target: 20,
    injuries: 'none',
  },
  opening: "My goal is just to run 20 miles a week, every week",
  initialState: { strava_snapshot: casualSnapshot() },
  expect: {
    offRamp: true,
    planGenerated: false,
    intentsInclude: ['20'],
  },
  customAssertions: (r) => {
    if (r.ports.enterDormant.length === 0)
      throw new Error('a volume goal should take the no-event off-ramp (enterDormant), not a plan');
    if (r.finalState.out_of_catalog != null)
      throw new Error('a volume goal opened the pocket — it must off-ramp, not proxy');
  },
};
