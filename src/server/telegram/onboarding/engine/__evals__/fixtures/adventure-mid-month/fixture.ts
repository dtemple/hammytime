// Phase 0 (V4 §9 "add"): a sub-40 personal adventure with only a month gets a real
// plan. event_kind 'adventure' (no race lookup), fuzzy "September" resolves to the
// 15th, event_distance_mi carries the real distance, and the plan generates.

import type { OnboardingFixture } from '../../types';
import { enduranceSnapshot } from '../_shared';

export const fixture: OnboardingFixture = {
  name: 'adventure-mid-month',
  persona:
    'Dana — clear, cooperative. Planning a personal long run (not an organized race). Has a month in mind but no exact day; happy to let the coach pick a provisional date. Confirms when the bot has it right.',
  facts: {
    goal: 'my own ~20-mile mountain run in September',
    organized_race: 'no — a personal adventure, my own route',
    distance: 'about 20 miles',
    when: 'sometime in September, no specific day picked',
    specific_day: "no — I don't have a day, the coach can pick a provisional one",
    experience: 'several years of consistent training',
    runs_per_week: 4,
    long_run_day: 'Sunday',
    injuries: 'nothing right now',
  },
  opening: "I'm planning my own 20-mile mountain run in September — not a race, just my own thing",
  initialState: { strava_snapshot: enduranceSnapshot() },
  raceLookup: {}, // an adventure has no catalog entry — lookup must not fire
  expect: {
    planGenerated: true,
    eventKind: 'adventure',
    lookupNotCalled: true,
    goalDateEndsWith: '-15',
    eventDistanceMi: 20,
  },
};
