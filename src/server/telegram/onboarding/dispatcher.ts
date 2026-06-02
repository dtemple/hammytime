import type { Context } from 'grammy';
import type { InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import type { Database } from '@/lib/db-types';
import { sendAndLog, telegramBot } from '../bot';
import { sendDavidAlert } from '@/server/admin/alerts';
import { advanceQuestion, loadOnboardingState } from './state';
import type { OnboardingState, OnboardingStep, Question } from './types';
import { onboardingSteps } from './index';

// Resolve a step's initialKeyboard, which may be a static keyboard or a
// per-athlete builder (e.g. pre-highlighting Strava-derived defaults).
async function resolveInitialKeyboard(
  step: OnboardingStep,
  athleteId: string,
): Promise<InlineKeyboard | undefined> {
  const k = step.initialKeyboard;
  if (!k) return undefined;
  return typeof k === 'function' ? await k(athleteId) : k;
}

// Walk forward from `fromIdx` (exclusive) past any step whose skipStep resolves
// true, returning the index of the first step to actually enter (or
// onboardingSteps.length if all remaining steps are skipped).
async function nextEnterableStep(fromIdx: number, athleteId: string): Promise<number> {
  let idx = fromIdx;
  while (idx < onboardingSteps.length) {
    const step = onboardingSteps[idx];
    if (!step?.skipStep || !(await step.skipStep(athleteId))) return idx;
    idx += 1;
  }
  return onboardingSteps.length;
}

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

// Send a message carrying an inline keyboard and persist it (sendAndLog is text-only).
async function sendWithKeyboard(
  athleteId: string,
  chatId: number | string,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  await telegramBot().api.sendMessage(chatId, text, { reply_markup: keyboard });
  await supabaseAdmin().from('messages').insert({
    athlete_id: athleteId,
    channel: 'tg',
    direction: 'out',
    body: text,
  });
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
      // A text answer can advance into a button screen (e.g. the enrichment echo +
      // confirm buttons): send a fresh keyboarded message when replyMarkup is set.
      if (result.reply && result.replyMarkup) {
        await sendWithKeyboard(athleteId, chatId, result.reply, result.replyMarkup);
      } else if (result.reply) {
        await sendAndLog(athleteId, chatId, result.reply);
      }
      return true;
    }
    // Step complete: run onComplete then advance to next step
    if (result.reply && result.replyMarkup) {
      await sendWithKeyboard(athleteId, chatId, result.reply, result.replyMarkup);
    } else if (result.reply) {
      await sendAndLog(athleteId, chatId, result.reply);
    }
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
  const nextStepIdx = await nextEnterableStep(state.step + 1, athleteId);

  if (nextStepIdx < onboardingSteps.length) {
    const nextStep = onboardingSteps[nextStepIdx];
    if (!nextStep) return false;

    // --- Dynamic entry (B1 plan preview): the step renders its own opening
    // message from freshly generated data. Advance first so a retry tap routes
    // back to this step; the step owns its failure copy, so onEnter throwing
    // here is a last-resort path only. ---
    if (nextStep.onEnter) {
      await advanceQuestion(athleteId, { step: nextStepIdx, question: 0, partial: {} });
      try {
        const { text, keyboard } = await nextStep.onEnter(athleteId);
        if (keyboard) await sendWithKeyboard(athleteId, chatId, text, keyboard);
        else await sendAndLog(athleteId, chatId, text);
      } catch (err) {
        console.error(`[onboarding] onEnter failed for step ${nextStep.id}`, err);
        await sendAndLog(athleteId, chatId, "Give me a moment — I'm putting your plan together.");
        await sendDavidAlert(
          `onEnter failed for step ${nextStep.id}, athlete ${athleteId}: ${String(err)}`,
        ).catch(() => {});
      }
      return true;
    }

    // --- Custom sub-flow step: send initialPrompt instead of questions[0] ---
    if (nextStep.handleMessage) {
      const newState: OnboardingState = {
        step: nextStepIdx,
        question: 0,
        partial: {},
      };
      await advanceQuestion(athleteId, newState);
      const keyboard = await resolveInitialKeyboard(nextStep, athleteId);
      if (keyboard && nextStep.initialPrompt) {
        // Send initialPrompt with inline keyboard; log separately (sendAndLog uses plain text API)
        await telegramBot().api.sendMessage(chatId, nextStep.initialPrompt, {
          reply_markup: keyboard,
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
    if (result.reply && result.replyMarkup) {
      await sendWithKeyboard(athleteId, chatId, result.reply, result.replyMarkup);
    } else if (result.reply) {
      await sendAndLog(athleteId, chatId, result.reply);
    }
    await step.onComplete(athleteId, result.newPartial);
    await completeStep(athleteId, chatId, { ...state, partial: result.newPartial });
    return;
  }

  await advanceQuestion(athleteId, {
    step: state.step,
    question: 0,
    partial: result.newPartial,
  });

  if (result.replyMarkup && result.reply) {
    // Multi-screen advance (e.g. goal → race-choice → distance): retire the old
    // keyboard so it can't be re-tapped, then send a fresh keyboarded message.
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await sendWithKeyboard(athleteId, chatId, result.reply, result.replyMarkup);
  } else if (result.replyMarkup) {
    // In-place re-render of the same screen (e.g. a toggle).
    await ctx.editMessageReplyMarkup({ reply_markup: result.replyMarkup });
  } else if (result.reply) {
    await sendAndLog(athleteId, chatId, result.reply);
  }
}
