import { profileConfirmStep } from './steps/00-profile-confirm';
import { goalSetupStep } from './steps/01-goal-setup';
import { trainingShapeStep } from './steps/02-training-shape';
import { injuryCheckStep } from './steps/03-injury-check';
import { enrichmentStep } from './steps/04-enrichment';
import type { OnboardingStep } from './types';

// Onboarding v2 (W2). Beat A0 (welcome + Connect Strava) lives in bot.handleStart;
// beat A1 enters step 0 (profile-confirm) via the Strava callback's resumeAfterStrava.
// Plan preview (B1) lands in W4 between injury-check and enrichment.
export const onboardingSteps: OnboardingStep[] = [
  profileConfirmStep, // A1 — confirm name/timezone from Strava
  goalSetupStep, // A2 + A4 + A4b — goal type + race / no-race
  trainingShapeStep, // A3 + A5 + A6 — experience, days/week, long-run day
  injuryCheckStep, // A7 — injury quick-check
  enrichmentStep, // C1 — optional freeform/voice dump
];

export { handleOnboardingCallback, handleOnboardingMessage } from './dispatcher';
export { advanceQuestion, resetOnboarding } from './state';
export { resumeAfterStrava } from './strava-resume';
export type { OnboardingState, OnboardingStep, ParseResult, Question } from './types';
