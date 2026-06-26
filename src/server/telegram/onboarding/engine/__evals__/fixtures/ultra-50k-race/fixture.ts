// Phase 0 (V4 §9 "add"): a 50k race selects the ultra-50k template — a real plan,
// effort-led, no time-goal pace driver. The frozen lookup returns a 31.1-mile race;
// the router derives the 50k bucket in code.

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'ultra-50k-race',
  persona:
    'Robin — direct, experienced trail runner. Running a 50k, just wants to finish strong, no time goal. Confirms when the bot has it right.',
  facts: {
    goal: 'run the Canyon 50K in October',
    race: 'Canyon 50K',
    distance: '50k',
    time_goal: 'no time goal — just finish strong',
    experience: 'years of trail and ultra training',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'none',
  },
  opening: "I'm running the Canyon 50K in October",
  initialState: { strava_snapshot: enduranceSnapshot({ road_trail_mix: { road: 0.3, trail: 0.7 } }) },
  raceLookup: {
    canyon: found('Canyon 50K', '2026-10-17', 31.1),
  },
  expect: {
    planGenerated: true,
    goalDistance: '50k',
    noTimeGoal: true,
  },
};
