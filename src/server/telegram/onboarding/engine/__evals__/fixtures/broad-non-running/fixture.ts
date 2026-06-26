// V3 §7 keep-verbatim (converted by v4): a broad non-running goal — general
// strength/fitness, no running event. The "I'm a running coach" boundary now routes
// to the no-event off-ramp consistently, not a forced base plan.

import type { OnboardingFixture } from '../../types';
import { casualSnapshot } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'broad-non-running',
  persona:
    'Devin — wants general fitness and strength, cross-training, not training for any running event. No race, no dated effort, now or later.',
  facts: {
    goal: 'general fitness and strength, mix of cross-training and some running',
    running_event: 'none — not training for a race or any dated run',
    runs_per_week: 2,
    injuries: 'none',
  },
  opening: "I'm not really into racing — I just want general fitness and to get stronger overall",
  initialState: { strava_snapshot: casualSnapshot({ run_count: 8, runs_per_week: 2 }) },
  expect: { offRamp: true, planGenerated: false, noBucketWritten: true },
  customAssertions: (r) => {
    if (r.ports.enterDormant.length === 0)
      throw new Error('expected the no-event off-ramp (enterDormant) for a broad non-running goal');
  },
};
