// Phase 0 (V4 §9 "add"): a stated distance past the 50k ceiling takes the W4 ultra
// off-ramp — acknowledge, state the 50k ceiling, ask for a shorter event. No bucket
// written, no consent chips, the goal rides as an intent. A forced turn-2 refusal pins
// the athlete to the off-ramp: without it the simulated persona accepts a 50k downgrade
// and the engine correctly builds a real 50k (a valid path — the athlete chose an
// in-catalog event — but not what THIS fixture asserts). Mid-conversation behavior check:
// the redirect does not converge on its own, which is fine (no terminal expected).

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'beyond-50k-offramp',
  persona:
    'Chase — terse, real answers, not chatty. Dead set on the 44-mile mountain run ' +
    'specifically. If the coach offers a shorter event or a 50k, he declines — he wants ' +
    'the 44 or nothing, and would rather have no plan than train for a different distance.',
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
  // Turn 2 is the response to the off-ramp offer (turn 1 = the opening). Pin the
  // refusal so the fixture exercises the PURE off-ramp (no bucket) rather than the
  // athlete accepting a 50k downgrade. The persona backstops later pushes.
  forcedMoves: [
    {
      turn: 2,
      move: {
        kind: 'text',
        body: "No, just the 44-miler. I'm not swapping it for a 50k or anything shorter — I'll sort the rest out myself.",
      },
    },
  ],
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
