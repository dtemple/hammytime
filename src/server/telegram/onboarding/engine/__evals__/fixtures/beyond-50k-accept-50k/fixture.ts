// Phase 0 (V4 §9 "add", companion to beyond-50k-offramp): the OTHER valid branch.
// A beyond-50k goal off-ramps (states the 50k ceiling, asks for a shorter event), the
// athlete ACCEPTS a 50k as their own personal effort, and the engine builds a real 50k
// plan. Proves the engine off-ramps FIRST — it never silently buckets the 44 to a 50k —
// and then honors an in-catalog downgrade. Forced turn-2 accept; the cooperative persona
// answers the rest (date pegs to the 15th, Strava-seeded shape confirmed, no injury).

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'beyond-50k-accept-50k',
  persona:
    'Riley — easygoing trail runner. Floated a big 44-mile mountain run, but when told ' +
    "it's past the 50k ceiling, happily downgrades to a 50k as their own personal effort " +
    '(their own route, not an organized race) and answers the rest cooperatively.',
  facts: {
    goal: 'a 44-mile mountain run in September — but happy to do a 50k instead',
    fallback: 'a 50k, my own route (not an organized race)',
    when: 'September, no specific day — fine letting the coach peg a provisional date',
    experience: 'several years of consistent trail training',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'nothing right now',
  },
  opening: 'I want to do a 44 mile mountain run in September',
  initialState: { strava_snapshot: enduranceSnapshot() },
  raceLookup: {}, // a personal 50k effort — no lookup should fire
  // Turn 2 is the response to the off-ramp offer (turn 1 = the opening). Pin the accept
  // so the fixture exercises the downgrade-to-a-real-plan branch; the persona handles
  // the date / shape / injury follow-ups from its facts.
  forcedMoves: [
    {
      turn: 2,
      move: {
        kind: 'text',
        body: "Yeah, a 50k works — my own route, not a race. Build me toward that.",
      },
    },
  ],
  expect: {
    planGenerated: true,
    goalDistance: '50k',
  },
  customAssertions: (r) => {
    // The off-ramp must fire FIRST: the engine states the 50k ceiling and never silently
    // buckets the 44 → 50k. The accept only sets the bucket AFTER that. (A bare /50k/i
    // match would also hit the plan-build chatter, so key on the off-ramp's signature.)
    const offRamped = r.transcript.some(
      (t) => t.direction === 'coach' && /top out at the 50k/i.test(t.body),
    );
    if (!offRamped)
      throw new Error('expected the 50k-ceiling off-ramp to fire before the downgrade');
  },
};
