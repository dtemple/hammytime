import { basicsStep } from './steps/00-basics';
import { goalsStep } from './steps/01-goals';
import { racesStep } from './steps/02-races';
import { injuriesStep } from './steps/03-injuries';
import { anythingElseStep } from './steps/04-anything-else';
import { recentMileageStep } from './steps/05-recent-mileage';
import { planForkStep } from './steps/06-plan-fork';
import type { OnboardingStep } from './types';

export const onboardingSteps: OnboardingStep[] = [
  basicsStep,
  goalsStep,
  racesStep,
  injuriesStep,
  anythingElseStep,
  recentMileageStep,
  planForkStep,
];

export { handleOnboardingCallback, handleOnboardingMessage } from './dispatcher';
export { resetOnboarding } from './state';
export type { OnboardingState, OnboardingStep, ParseResult, Question } from './types';
