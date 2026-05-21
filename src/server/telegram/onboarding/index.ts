import { basicsStep } from "./steps/00-basics";
import { goalsStep } from "./steps/01-goals";
import { racesStep } from "./steps/02-races";
import { injuriesStep } from "./steps/03-injuries";
import type { OnboardingStep } from "./types";

export const onboardingSteps: OnboardingStep[] = [
  basicsStep,
  goalsStep,
  racesStep,
  injuriesStep,
];

export { handleOnboardingCallback, handleOnboardingMessage } from "./dispatcher";
export { resetOnboarding } from "./state";
export type {
  OnboardingState,
  OnboardingStep,
  ParseResult,
  Question,
} from "./types";
