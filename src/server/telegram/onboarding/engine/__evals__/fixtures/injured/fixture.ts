// V3 §7 keep-verbatim: an athlete with an active injury. The injury beat is asked,
// injury_status lands 'active' (not 'none'), and the plan still generates.

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'injured',
  persona:
    'Morgan — straightforward, mentions an ongoing injury when asked. Wants to train around it, not ignore it.',
  facts: {
    goal: 'the Valley Marathon in December',
    race: 'Valley Marathon',
    date: '2026-12-13',
    distance: 'marathon',
    experience: 'several years of training',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'right achilles has been flaring up the last few weeks, currently bothering me',
  },
  opening: "Training for the Valley Marathon in December, but my achilles has been acting up",
  initialState: { strava_snapshot: enduranceSnapshot() },
  raceLookup: { valley: found('Valley Marathon', '2026-12-13', 26.2) },
  expect: { planGenerated: true, goalDistance: 'marathon' },
  customAssertions: (r) => {
    const status = r.finalState.slots.injury_status?.value;
    if (status !== 'active' && status !== 'monitoring')
      throw new Error(`expected injury_status active/monitoring, got ${String(status)}`);
  },
};
