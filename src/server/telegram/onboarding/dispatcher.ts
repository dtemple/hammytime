import type { Context } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import type { Database } from '@/lib/db-types';
import { sendAndLog, telegramBot } from '../bot';
import { advanceQuestion, loadOnboardingState } from './state';
import type { OnboardingState, Question } from './types';
import { onboardingSteps } from './index';

type AthleteRow = Database['public']['Tables']['athletes']['Row'];

// Returns the index of the first non-skipped question at or after `start`
// within the given questions array, given the current partial answers.
// Returns -1 if all remaining questions are skipped.
function firstActiveQuestion(
  questions: Question[],
  start: number,
  partial: Record<string, unknown>,
): number {
  for (let i = start; i < questions.length; i++) {
    const q = questions[i];
    if (q && !q.skip?.(partial)) return i;
  }
  return -1;
}

async function logInbound(athleteId: string, body: string): Promise<void> {
  await supabaseAdmin().from('messages').insert({
    athlete_id: athleteId,
    channel: 'tg',
    direction: 'in',
    body,
  });
}

async function askQuestion(
  chatId: number | string,
  athleteId: string,
  question: Question,
): Promise<void> {
  await sendAndLog(athleteId, chatId, question.prompt);
}

/**
 * Routes an inbound text message through the onboarding state machine.
 *
 * Returns true  — message was handled (onboarding in progress or just finished this turn).
 * Returns false — onboarding is already complete; caller should route elsewhere.
 */
export async function handleOnboardingMessage(ctx: Context, athlete: AthleteRow): Promise<boolean> {
  const athleteId = athlete.id;
  const chatId = ctx.chat!.id;
  const text = ctx.message?.text ?? '';

  await logInbound(athleteId, text);

  const state = await loadOnboardingState(athleteId);

  // Onboarding already complete
  if (state.step >= onboardingSteps.length) return false;

  const step = onboardingSteps[state.step];
  if (!step) return false;

  // --- Custom sub-flow steps (e.g. step 2 races) ---
  if (step.handleMessage) {
    const result = await step.handleMessage(text, state.partial, athleteId);
    if (!result.done) {
      await advanceQuestion(athleteId, {
        step: state.step,
        question: 0,
        partial: result.newPartial,
      });
      if (result.reply) await sendAndLog(athleteId, chatId, result.reply);
      return true;
    }
    // Step complete: run onComplete then advance to next step
    if (result.reply) await sendAndLog(athleteId, chatId, result.reply);
    await step.onComplete(athleteId, result.newPartial);
    return await completeStep(athleteId, chatId, { ...state, partial: result.newPartial });
  }

  // --- Standard question-array steps ---
  const questionIdx = firstActiveQuestion(step.questions, state.question, state.partial);

  // All remaining questions in this step are skipped — complete immediately
  if (questionIdx === -1) {
    return await completeStep(athleteId, chatId, state);
  }

  const question = step.questions[questionIdx];
  if (!question) return false;

  const result = question.parseReply(text, state.partial);

  if (!result.ok) {
    await sendAndLog(athleteId, chatId, `${result.error}\n\n${question.prompt}`);
    return true;
  }

  const newPartial = { ...state.partial, [question.key]: result.value };

  // Find the next active question in this step
  const nextIdx = firstActiveQuestion(step.questions, questionIdx + 1, newPartial);

  if (nextIdx !== -1) {
    // More questions remain in this step
    const nextQuestion = step.questions[nextIdx];
    const newState: OnboardingState = {
      step: state.step,
      question: nextIdx,
      partial: newPartial,
    };
    await advanceQuestion(athleteId, newState);
    if (nextQuestion) await askQuestion(chatId, athleteId, nextQuestion);
    return true;
  }

  // Last question of the step — run onComplete
  await step.onComplete(athleteId, newPartial);
  return await completeStep(athleteId, chatId, { ...state, partial: newPartial });
}

async function completeStep(
  athleteId: string,
  chatId: number | string,
  state: OnboardingState,
): Promise<boolean> {
  const nextStepIdx = state.step + 1;

  if (nextStepIdx < onboardingSteps.length) {
    const nextStep = onboardingSteps[nextStepIdx];
    if (!nextStep) return false;

    // --- Custom sub-flow step: send initialPrompt instead of questions[0] ---
    if (nextStep.handleMessage) {
      const newState: OnboardingState = {
        step: nextStepIdx,
        question: 0,
        partial: {},
      };
      await advanceQuestion(athleteId, newState);
      if (nextStep.initialKeyboard && nextStep.initialPrompt) {
        // Send initialPrompt with inline keyboard; log separately (sendAndLog uses plain text API)
        await telegramBot().api.sendMessage(chatId, nextStep.initialPrompt, {
          reply_markup: nextStep.initialKeyboard,
        });
        await supabaseAdmin().from('messages').insert({
          athlete_id: athleteId,
          channel: 'tg',
          direction: 'out',
          body: nextStep.initialPrompt,
        });
      } else if (nextStep.initialPrompt) {
        await sendAndLog(athleteId, chatId, nextStep.initialPrompt);
      }
      return true;
    }

    // --- Standard step: send first active question ---
    const emptyPartial: Record<string, unknown> = {};
    const firstQIdx = firstActiveQuestion(nextStep.questions, 0, emptyPartial);

    const newState: OnboardingState = {
      step: nextStepIdx,
      question: firstQIdx === -1 ? 0 : firstQIdx,
      partial: emptyPartial,
    };
    await advanceQuestion(athleteId, newState);

    if (firstQIdx !== -1) {
      const firstQ = nextStep.questions[firstQIdx];
      if (firstQ) await askQuestion(chatId, athleteId, firstQ);
    }
    return true;
  }

  // All steps complete
  const terminalState: OnboardingState = {
    step: onboardingSteps.length,
    question: 0,
    partial: {},
  };
  await advanceQuestion(athleteId, terminalState);

  // All steps complete — no message here; step 6's build/help handlers already sent confirmation.
  return false;
}

/**
 * Routes an inbound callback_query:data event through the onboarding state machine.
 * Mirrors handleOnboardingMessage but delegates to handleCallback instead of handleMessage.
 */
export async function handleOnboardingCallback(
  ctx: Context,
  athlete: AthleteRow,
  data: string,
): Promise<void> {
  const athleteId = athlete.id;
  const chatId = ctx.chat!.id;
  const state = await loadOnboardingState(athleteId);

  const step = onboardingSteps[state.step];
  if (!step?.handleCallback) {
    await ctx.answerCallbackQuery();
    return;
  }

  const result = await step.handleCallback(data, state.partial, athleteId);

  // Dismiss the spinner; show alert if the step requested one
  if (!result.done && result.alertText) {
    await ctx.answerCallbackQuery({ text: result.alertText, show_alert: true });
  } else {
    await ctx.answerCallbackQuery();
  }

  if (result.done) {
    if (result.reply) await sendAndLog(athleteId, chatId, result.reply);
    await step.onComplete(athleteId, result.newPartial);
    await completeStep(athleteId, chatId, { ...state, partial: result.newPartial });
    return;
  }

  await advanceQuestion(athleteId, {
    step: state.step,
    question: 0,
    partial: result.newPartial,
  });

  if (result.replyMarkup) {
    await ctx.editMessageReplyMarkup({ reply_markup: result.replyMarkup });
  }
  if (result.reply) {
    await sendAndLog(athleteId, chatId, result.reply);
  }
}
