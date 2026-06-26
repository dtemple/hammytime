// V3 §7 keep-verbatim: a terse athlete, one or two words per turn. The simulator's
// anti-desync rule keeps it answering; the engine must still gather every slot.

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'terse-one-word',
  persona: 'Sam — extremely terse. One or two words per reply. Answers, but volunteers nothing.',
  facts: {
    goal: 'half marathon',
    race: 'River Half',
    date: '2026-10-04',
    distance: 'half',
    experience: 'some structured training',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'none',
  },
  opening: 'River Half.',
  initialState: { strava_snapshot: enduranceSnapshot({ longest_run_mi: 11, recent_weekly_mileage_mi: 24 }) },
  raceLookup: { river: found('River Half', '2026-10-04', 13.1) },
  expect: { planGenerated: true, goalDistance: 'half' },
};
