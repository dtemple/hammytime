export interface OnboardingState {
  step: number;
  question: number;
  partial: Record<string, unknown>;
}

export type ParseResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface Question<T = unknown> {
  key: string;
  prompt: string;
  parseReply: (
    text: string,
    partial: Record<string, unknown>
  ) => ParseResult<T>;
  skip?: (partial: Record<string, unknown>) => boolean;
}

// Returned by OnboardingStep.handleMessage for steps that manage their own sub-flow.
export type StepHandleResult =
  | { done: false; newPartial: Record<string, unknown>; reply: string }
  | { done: true; newPartial: Record<string, unknown> };

export interface OnboardingStep {
  id: string;
  questions: Question[];
  onComplete: (
    athleteId: string,
    partial: Record<string, unknown>
  ) => Promise<void>;
  // If defined, the dispatcher delegates all inbound messages to this method
  // instead of iterating through questions[]. The method manages its own sub-flow
  // via partial and returns the next message to send plus whether the step is done.
  // athleteId is passed so the step can call async helpers (e.g. lookupRace).
  handleMessage?: (
    text: string,
    partial: Record<string, unknown>,
    athleteId: string
  ) => Promise<StepHandleResult>;
  // Sent when the dispatcher first transitions into this step. Used by steps
  // with handleMessage to fire the opening question without needing a dummy Question entry.
  initialPrompt?: string;
}
