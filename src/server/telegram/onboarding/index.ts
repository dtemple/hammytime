import { basicsStep } from "./steps/00-basics";
import { goalsStep } from "./steps/01-goals";
import type { OnboardingStep } from "./types";

export const onboardingSteps: OnboardingStep[] = [basicsStep, goalsStep];

export { handleOnboardingMessage } from "./dispatcher";
export { resetOnboarding } from "./state";
export type { OnboardingState, OnboardingStep, Question, ParseResult } from "./types";
