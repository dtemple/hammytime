import type { InlineKeyboard } from 'grammy';

export interface OnboardingState {
  step: number;
  question: number;
  partial: Record<string, unknown>;
}

export type ParseResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

export interface Question<T = unknown> {
  key: string;
  prompt: string;
  parseReply: (text: string, partial: Record<string, unknown>) => ParseResult<T>;
  skip?: (partial: Record<string, unknown>) => boolean;
}

// Returned by OnboardingStep.handleMessage / handleCallback for steps that manage their own sub-flow.
export type StepHandleResult =
  | {
      done: false;
      newPartial: Record<string, unknown>;
      reply?: string;
      // If set, dispatcher calls ctx.editMessageReplyMarkup with this keyboard.
      replyMarkup?: InlineKeyboard;
      // If set, dispatcher answers callback query with show_alert:true.
      alertText?: string;
    }
  | {
      done: true;
      newPartial: Record<string, unknown>;
      // If set, dispatcher sends this before calling onComplete.
      reply?: string;
      // If set alongside reply, the final message carries this inline keyboard
      // (e.g. the terminal next-actions: Add to calendar / Adjust / Done).
      replyMarkup?: InlineKeyboard;
    };

export interface OnboardingStep {
  id: string;
  questions: Question[];
  onComplete: (athleteId: string, partial: Record<string, unknown>) => Promise<void>;
  // If defined, the dispatcher delegates all inbound messages to this method
  // instead of iterating through questions[]. The method manages its own sub-flow
  // via partial and returns the next message to send plus whether the step is done.
  // athleteId is passed so the step can call async helpers (e.g. lookupRace).
  handleMessage?: (
    text: string,
    partial: Record<string, unknown>,
    athleteId: string,
  ) => Promise<StepHandleResult>;
  // If defined, the dispatcher delegates callback_query:data events to this method.
  handleCallback?: (
    data: string,
    partial: Record<string, unknown>,
    athleteId: string,
  ) => Promise<StepHandleResult>;
  // Sent when the dispatcher first transitions into this step. Used by steps
  // with handleMessage to fire the opening question without needing a dummy Question entry.
  initialPrompt?: string;
  // If set, sent alongside initialPrompt as reply_markup (inline keyboard).
  // May be a function so the keyboard can be built from per-athlete data (e.g.
  // pre-highlighting the Strava-suggested experience tier / days / long-run day);
  // the dispatcher awaits it at transition time.
  initialKeyboard?: InlineKeyboard | ((athleteId: string) => Promise<InlineKeyboard>);
  // If defined, the dispatcher calls this on step entry to build a DYNAMIC
  // opening message (text + optional keyboard) — used by the B1 plan preview,
  // whose text is rendered from the freshly generated plan. Takes precedence
  // over initialPrompt/initialKeyboard. The step owns its own failure copy;
  // the dispatcher only sends a last-resort fallback if onEnter throws.
  onEnter?: (athleteId: string) => Promise<{ text: string; keyboard?: InlineKeyboard }>;
  // If defined and resolves true, the dispatcher skips this step entirely on entry
  // and advances to the next. Async + DB-backed because partial is wiped between
  // steps. Unused in W2; reserved for the day-to-day path (W3/W4).
  skipStep?: (athleteId: string) => Promise<boolean>;
}
