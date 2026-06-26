// Smoke fixture (Part 2): a clean marathon onboard. Strava signal present (so the
// inferred shape slots seed and get confirmed), a named race resolved by the
// frozen lookup, no injury. The one assertion: the conversation reaches plan-gen.

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'marathon-smoke',
  persona: 'Sam — friendly, gives clear direct answers, confirms when the bot has it right.',
  facts: {
    goal: 'run the California International Marathon (CIM) this December',
    race: 'California International Marathon',
    date: '2026-12-06',
    distance: 'marathon',
    experience: 'a few years of consistent training',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'nothing right now, healthy',
  },
  opening: "I want to train for the California International Marathon this December",
  initialState: {
    strava_snapshot: enduranceSnapshot({ recent_weekly_mileage_mi: 35, longest_run_mi: 16 }),
  },
  raceLookup: {
    'california international': found('California International Marathon', '2026-12-06', 26.2),
    cim: found('California International Marathon', '2026-12-06', 26.2),
  },
  expect: {
    planGenerated: true,
    goalDistance: 'marathon',
  },
};
