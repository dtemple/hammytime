// V3 §7 keep-verbatim: a safety contradiction — five weeks of running, a first
// marathon, twelve weeks out. The engine must surface the conflict (a contradiction
// signal / a confirm) before generating, not silently build an aggressive plan.

import type { OnboardingFixture } from '../../types';
import { casualSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'safety-contradiction',
  persona:
    'Jamie — new runner, eager and a little over-ambitious. Started running five weeks ago and wants a full marathon in twelve weeks. Will hear out a reality check.',
  facts: {
    goal: 'a first-ever marathon, twelve weeks from now',
    race: 'Downtown Marathon',
    date: '2026-09-17', // ~12 weeks from the 2026-06-25 baseline
    distance: 'marathon',
    experience: 'started running five weeks ago, never raced',
    runs_per_week: 3,
    long_run_day: 'Saturday',
    injuries: 'none',
  },
  opening: "I started running 5 weeks ago and I want to do my first marathon in 12 weeks",
  initialState: { strava_snapshot: casualSnapshot({ weeks_observed: 5, run_count: 12, longest_run_mi: 4 }) },
  raceLookup: { downtown: found('Downtown Marathon', '2026-09-17', 26.2) },
  // The contradiction is a mid-conversation safety beat; convergence to a plan is
  // not the thing under test here, so no terminal is required.
  expect: {},
  customAssertions: (r) => {
    const flagged =
      r.modelTurns.some((t) => t.contradiction != null) ||
      r.modelTurns.some((t) => t.next_action === 'confirm');
    if (!flagged)
      throw new Error('the safety contradiction was never surfaced (no contradiction signal / confirm)');
    // It must not have silently generated on the first pass.
    if (r.ports.generateAndPersistPlan > 0 && r.modelTurns.length <= 1)
      throw new Error('generated immediately without surfacing the contradiction');
  },
};
