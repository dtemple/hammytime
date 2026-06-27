// The fixture registry. The eval entry drives every fixture here against live
// Sonnet. Grouped by phase for readability.

import type { OnboardingFixture } from '../types';

import { fixture as marathonSmoke } from './marathon-smoke/fixture';

// Phase 0 — the v4 gate fixtures (the deltas with no v3 coverage).
import { fixture as generalFitnessOfframp } from './general-fitness-offramp/fixture';
import { fixture as beyond50kOfframp } from './beyond-50k-offramp/fixture';
import { fixture as beyond50kAccept50k } from './beyond-50k-accept-50k/fixture';
import { fixture as adventureMidMonth } from './adventure-mid-month/fixture';
import { fixture as ultra50kRace } from './ultra-50k-race/fixture';

// Phase 1 — the ported v3 set (keep-verbatim + converted).
import { fixture as chattyOverAnswerer } from './chatty-over-answerer/fixture';
import { fixture as terseOneWord } from './terse-one-word/fixture';
import { fixture as voiceDisfluent } from './voice-disfluent/fixture';
import { fixture as adversarialWhy } from './adversarial-why/fixture';
import { fixture as coldStartNoStrava } from './cold-start-no-strava/fixture';
import { fixture as injured } from './injured/fixture';
import { fixture as injurySkipper } from './injury-skipper/fixture';
import { fixture as messyTimeGoal } from './messy-time-goal/fixture';
import { fixture as safetyContradiction } from './safety-contradiction/fixture';
import { fixture as confirmLoopReplay } from './confirm-loop-replay/fixture';
import { fixture as goalChange } from './goal-change/fixture';
import { fixture as broadNonRunning } from './broad-non-running/fixture';
import { fixture as volumeGoal } from './volume-goal/fixture';

const phase0: OnboardingFixture[] = [
  generalFitnessOfframp,
  beyond50kOfframp,
  beyond50kAccept50k,
  adventureMidMonth,
  ultra50kRace,
];

const phase1: OnboardingFixture[] = [
  chattyOverAnswerer,
  terseOneWord,
  voiceDisfluent,
  adversarialWhy,
  coldStartNoStrava,
  injured,
  injurySkipper,
  messyTimeGoal,
  safetyContradiction,
  confirmLoopReplay,
  goalChange,
  broadNonRunning,
  volumeGoal,
];

export const fixtures: OnboardingFixture[] = [marathonSmoke, ...phase0, ...phase1];
