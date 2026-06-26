// V3 §7 keep-verbatim: the injury-skipper taps [Skip] on the injury beat, which
// writes injury_status 'unknown' (a soft-gate answer, never "healthy") and still
// generates a conservative plan.
//
// knownFlaky: the exact [Skip] chip label and the turn it appears on are model-
// shaped and not knowable without a live run. The persona is told to tap the
// skip/none-of-the-above button; once a live run confirms the label, this can drop
// the flaky flag (or pin the tap with a forcedMove).

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'injury-skipper',
  persona:
    "Lee — does not want to discuss injuries. When the coach asks about injuries or aches, taps the button that skips the question (a 'Skip' / 'Rather not say' / 'Prefer not to answer' option) rather than typing anything.",
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
  knownFlaky: 'exact [Skip] chip label/turn unverified without a live run',
  expect: { planGenerated: true, goalDistance: 'half' },
  customAssertions: (r) => {
    const status = r.finalState.slots.injury_status?.value;
    if (status !== 'unknown')
      throw new Error(`injury-skipper should leave injury_status 'unknown', got ${String(status)}`);
  },
};
