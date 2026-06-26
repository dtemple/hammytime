// V3 §7 keep-verbatim: an adversarial athlete who pushes back on why the bot needs
// each detail. The engine should answer plainly and still gather what it needs; the
// simulator's anti-desync rule makes the athlete relent and answer on the re-ask.

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'adversarial-why',
  persona:
    'Riley — skeptical and a bit prickly. Questions why the bot needs each piece of info before answering. Not hostile, just guarded — answers once given a plain reason, and never stonewalls the same question twice.',
  facts: {
    goal: 'the Harbor 10K in September',
    race: 'Harbor 10K',
    date: '2026-09-20',
    distance: '10k',
    experience: 'runs regularly, some training background',
    runs_per_week: 4,
    long_run_day: 'Saturday',
    injuries: 'none',
  },
  opening: "Why do you need all this info just to give me a running plan?",
  initialState: { strava_snapshot: enduranceSnapshot({ longest_run_mi: 9, recent_weekly_mileage_mi: 22 }) },
  raceLookup: { harbor: found('Harbor 10K', '2026-09-20', 6.2) },
  expect: { planGenerated: true, goalDistance: '10k' },
};
