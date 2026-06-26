// Phase 0 (V4 §9 "add"): a stated distance past the 50k ceiling takes the W4 ultra
// off-ramp — acknowledge, state the 50k ceiling, ask for a shorter event. No bucket
// written, no consent chips, the goal rides as an intent. This is a mid-conversation
// behavior check: the redirect asks for a shorter event and does not converge on its
// own, which is fine (no terminal expected).

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'beyond-50k-offramp',
  persona: 'Chase — terse, real answers, not chatty. Has his heart set on a big mountain ultra.',
  facts: {
    goal: 'a 44-mile mountain run in September',
    distance: '44 miles',
    when: 'September',
    runs_per_week: 3,
    injuries: 'long-standing right ITB, manageable',
  },
  opening: 'I want to do a 44 mile mountain run in September',
  initialState: { strava_snapshot: enduranceSnapshot({ recent_weekly_mileage_mi: 15, longest_run_mi: 12 }) },
  raceLookup: {}, // athlete-stated effort — no lookup should fire
  expect: {
    noBucketWritten: true,
    lookupNotCalled: true,
  },
  customAssertions: (r) => {
    const ceilingHit = r.transcript.some(
      (t) => t.direction === 'coach' && /50k/i.test(t.body),
    );
    if (!ceilingHit) throw new Error('expected a coach message to state the 50k ceiling');
    // The beyond-50k goal should ride on as coach context (an intent), but the
    // exact phrasing is model/code-shaped — assert presence, not a digit.
    if ((r.finalState.intents ?? []).length === 0)
      throw new Error('expected the beyond-50k goal to ride on as an intent');
    // The redirect is an open ask, never a proxy-consent offer.
    const consentChips = r.transcript.some(
      (t) => t.direction === 'coach' && (t.chips ?? []).some((c) => /do that|not now/i.test(c.label)),
    );
    if (consentChips) throw new Error('a proxy-consent chip set appeared on the off-ramp');
  },
};
