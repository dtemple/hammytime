import { profileConfirmStep } from './steps/00-profile-confirm';
import { goalSetupStep } from './steps/01-goal-setup';
import { trainingShapeStep } from './steps/02-training-shape';
import { injuryCheckStep } from './steps/03-injury-check';
import { planPreviewStep } from './steps/04-plan-preview';
import { enrichmentStep } from './steps/05-enrichment';
import type { OnboardingStep } from './types';

// Onboarding v2. Beat A0 (welcome + Connect Strava) lives in bot.handleStart;
// beat A1 enters step 0 (profile-confirm) via the Strava callback's resumeAfterStrava.
// B1 (plan preview, W4) sits between injury-check and enrichment — payoff before enrichment.
export const onboardingSteps: OnboardingStep[] = [
  profileConfirmStep, // A1 — confirm name/timezone from Strava
  goalSetupStep, // A2 + A4 + A4b — goal type + race / no-race
  trainingShapeStep, // A3 + A5 + A6 — experience, days/week, long-run day
  injuryCheckStep, // A7 — injury quick-check
  planPreviewStep, // B1 — generate + persist + preview (Looks good / Adjust it)
  enrichmentStep, // C1 — optional freeform/voice dump (terminal + next-actions)
];

export { handleOnboardingCallback, handleOnboardingMessage } from './dispatcher';
export { advanceQuestion, resetOnboarding } from './state';
export { resumeAfterStrava } from './strava-resume';
export type { OnboardingState, OnboardingStep, ParseResult, Question } from './types';
