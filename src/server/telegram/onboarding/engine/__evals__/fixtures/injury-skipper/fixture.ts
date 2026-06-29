// The injury-skipper dodges the injury beat by typing a non-answer (there is no
// [Skip] chip anymore — ONBOARDING_CHIPS §6). Soft-via-open: the beat is asked, the
// athlete declines, injury_status stays OPEN (no stored value), and the plan still
// generates. The safety floor is "the beat was asked", which the assertion checks.
//
// knownFlaky: the exact turn the dodge lands on is model-shaped and not knowable
// without a live run.

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'injury-skipper',
  persona:
    "Lee — does not want to discuss injuries. When the coach asks about injuries or aches, types a brief non-answer (e.g. 'I'd rather not get into it' / 'let's skip that') rather than naming anything. Does NOT tap the 'Nothing right now' button — that would assert no injury, which isn't what Lee means.",
  facts: {
    goal: 'the Summit Half in October',
    race: 'Summit Half',
    date: '2026-10-25',
    distance: 'half',
    experience: 'some structured training',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'declines to answer',
  },
  opening: "I want to do the Summit Half in October",
  initialState: { strava_snapshot: enduranceSnapshot({ longest_run_mi: 11 }) },
  raceLookup: { summit: found('Summit Half', '2026-10-25', 13.1) },
  knownFlaky: 'the turn the dodge lands on is model-shaped without a live run',
  expect: { planGenerated: true, goalDistance: 'half' },
  customAssertions: (r) => {
    // Soft-via-open: a dodge leaves injury_status unset, but the beat must have been
    // asked (that's what lets onboarding complete without an answer).
    const status = r.finalState.slots.injury_status?.value;
    if (status != null)
      throw new Error(`injury-skipper should leave injury_status open, got ${String(status)}`);
    if (!r.finalState.asked.includes('injury_status'))
      throw new Error('injury-skipper completed without the injury beat ever being asked');
  },
};
