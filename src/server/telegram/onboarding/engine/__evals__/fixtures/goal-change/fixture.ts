// V3 §7 keep-verbatim: a goal change mid-flow. The athlete confirms one race, then
// switches to a different race with a different date. The old race's date must NOT
// survive onto the new goal (the R1 fix-3 invariant).

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

const RACE_A_DATE = '2026-10-11';
const RACE_B_DATE = '2026-12-06';

export const fixture: OnboardingFixture = {
  name: 'goal-change',
  persona:
    'Quinn — decisive. Names one race, then changes their mind to a different one a couple of turns in. Cooperative otherwise.',
  facts: {
    first_race: 'Autumn Marathon (October)',
    final_race: 'Coastal Marathon (December)',
    distance: 'marathon',
    experience: 'several years of training',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'none',
  },
  opening: "I'm signed up for the Autumn Marathon",
  initialState: { strava_snapshot: enduranceSnapshot() },
  raceLookup: {
    autumn: found('Autumn Marathon', RACE_A_DATE, 26.2),
    coastal: found('Coastal Marathon', RACE_B_DATE, 26.2),
  },
  // Force the switch on turn 3 so it lands deterministically regardless of how the
  // bot phrases its early questions.
  forcedMoves: [
    { turn: 3, move: { kind: 'text', body: 'Actually, change it — I want to do the Coastal Marathon instead' } },
  ],
  expect: { goalDistance: 'marathon' },
  customAssertions: (r) => {
    const date = r.finalState.slots.goal_date?.value;
    if (date === RACE_A_DATE)
      throw new Error("the superseded race's date survived the goal change (R1 fix-3 regression)");
  },
};
