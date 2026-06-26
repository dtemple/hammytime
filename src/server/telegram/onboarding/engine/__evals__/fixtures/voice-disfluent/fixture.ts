// V3 §7 keep-verbatim: voice-transcribed input — disfluent, run-on, lowercase, no
// punctuation. The engine must parse intent through the noise.

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot, found } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'voice-disfluent',
  persona:
    'Pat — talks to the bot via voice-to-text. Replies are run-on, lowercase, full of filler ("um", "like", "you know"), no punctuation. The content is real, the form is messy.',
  facts: {
    goal: 'the City Marathon next spring',
    race: 'City Marathon',
    date: '2027-04-18',
    distance: 'marathon',
    experience: 'a couple years running, did one half before',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'knee was cranky a while back but fine now',
  },
  opening:
    "um so yeah i was thinking like i wanna do the city marathon next spring you know ive been running a couple years did a half once and uh yeah",
  initialState: { strava_snapshot: enduranceSnapshot() },
  raceLookup: { city: found('City Marathon', '2027-04-18', 26.2) },
  expect: { planGenerated: true, goalDistance: 'marathon' },
};
