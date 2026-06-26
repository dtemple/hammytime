// V3 §7 keep-verbatim: a chatty athlete who dumps everything in the first message.
// The engine must fill slots from the dump without re-asking, then converge.

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'chatty-over-answerer',
  persona:
    'Alex — warm, over-shares, answers more than asked. Tells the whole story up front and elaborates happily.',
  facts: {
    goal: 'run the Mountain Marathon in November and finish strong',
    race: 'Mountain Marathon',
    date: '2026-11-08',
    distance: 'marathon',
    experience: 'been running consistently for about five years',
    runs_per_week: 5,
    long_run_day: 'Saturday',
    injuries: 'nothing right now, totally healthy',
    extra: 'also wants to get faster at shorter distances over time',
  },
  opening:
    "Okay so I've been running about five years now, usually 5 days a week with my long run on Saturdays, and I really want to do the Mountain Marathon in November and finish strong — also I'd love to get faster at 10Ks eventually. No injuries, feeling great!",
  initialState: { strava_snapshot: enduranceSnapshot({ runs_per_week: 5, dominant_long_run_weekday: 6 }) },
  raceLookup: { mountain: found('Mountain Marathon', '2026-11-08', 26.2) },
  expect: { planGenerated: true, goalDistance: 'marathon' },
};
