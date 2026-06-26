// V3 §7 keep-verbatim: no Strava signal at all. The engine must ASK for training
// shape (days/week, long-run day, experience) rather than infer it.

import type { OnboardingFixture } from '../../types';
import { found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'cold-start-no-strava',
  persona:
    'Casey — no useful activity history connected. Cooperative, gives clear answers when asked about training shape.',
  facts: {
    goal: 'the Lakeside Half in November',
    race: 'Lakeside Half',
    date: '2026-11-15',
    distance: 'half',
    experience: 'some structured training, ran a 10k last year',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'none',
  },
  opening: "I want to train for the Lakeside Half in November",
  initialState: { strava_snapshot: null }, // cold start — no signal
  raceLookup: { lakeside: found('Lakeside Half', '2026-11-15', 13.1) },
  expect: { planGenerated: true, goalDistance: 'half' },
  customAssertions: (r) => {
    // With no Strava signal the shape slots cannot be inferred — they must arrive
    // as the athlete's stated answers, never as inferred fills.
    const inferredShape = r.modelTurns.some((t) =>
      t.fills.some(
        (f) =>
          ['days_per_week', 'long_run_day', 'experience_tier'].includes(f.slot) &&
          f.provenance === 'inferred',
      ),
    );
    if (inferredShape)
      throw new Error('shape slots were inferred despite no Strava signal (cold start must ask)');
  },
};
