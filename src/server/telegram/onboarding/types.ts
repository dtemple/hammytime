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

export interface OnboardingStep {
  id: string;
  questions: Question[];
  onComplete: (
    athleteId: string,
    partial: Record<string, unknown>
  ) => Promise<void>;
}
