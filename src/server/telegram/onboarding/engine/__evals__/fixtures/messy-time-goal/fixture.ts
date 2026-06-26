// V3 §7 keep-verbatim: a messy time goal. "10 minute miles for a marathon" is a
// pace → the engine computes the implied finish (~4:22). The resolved target_time
// must land in a plausible marathon range, not the bare per-mile number.

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'messy-time-goal',
  persona:
    'Taylor — states the time goal as a pace ("10 minute miles"). If the bot asks to confirm the reading, picks the marathon finish-time interpretation, not a 10-minute total.',
  facts: {
    goal: 'a marathon at about 10-minute-mile pace',
    race: 'Metro Marathon',
    date: '2026-11-22',
    distance: 'marathon',
    time_goal: '10 minute miles (a ~4:22 finish)',
    experience: 'several years of training',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'none',
  },
  opening: "I want to run the Metro Marathon at like 10 minute miles",
  initialState: { strava_snapshot: enduranceSnapshot() },
  raceLookup: { metro: found('Metro Marathon', '2026-11-22', 26.2) },
  expect: { planGenerated: true, goalDistance: 'marathon' },
  customAssertions: (r) => {
    const t = r.finalState.slots.target_time?.value;
    if (typeof t !== 'number')
      throw new Error(`expected a resolved numeric target_time, got ${String(t)}`);
    // A marathon at 10 min/mi ≈ 15720s. Accept the plausible marathon band; reject
    // a bare per-mile (600s) or a 10-minute total (600s) misread.
    if (t < 3 * 3600 || t > 6 * 3600)
      throw new Error(`target_time ${t}s is outside the plausible marathon finish band (3–6h)`);
  },
};
