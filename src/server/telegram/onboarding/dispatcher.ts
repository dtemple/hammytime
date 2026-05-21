import type { Context } from "grammy";
import { supabaseAdmin } from "@/lib/db";
import type { Database } from "@/lib/db-types";
import { sendAndLog } from "../bot";
import { advanceQuestion, loadOnboardingState } from "./state";
import type { OnboardingState, Question } from "./types";
import { onboardingSteps } from "./index";

type AthleteRow = Database["public"]["Tables"]["athletes"]["Row"];

// Returns the index of the first non-skipped question at or after `start`
// within the given questions array, given the current partial answers.
// Returns -1 if all remaining questions are skipped.
function firstActiveQuestion(
  questions: Question[],
  start: number,
  partial: Record<string, unknown>
): number {
  for (let i = start; i < questions.length; i++) {
    const q = questions[i];
    if (q && !q.skip?.(partial)) return i;
  }
  return -1;
}

async function logInbound(athleteId: string, body: string): Promise<void> {
  await supabaseAdmin().from("messages").insert({
    athlete_id: athleteId,
    channel: "tg",
    direction: "in",
    body,
  });
}

async function askQuestion(
  chatId: number | string,
  athleteId: string,
  question: Question
): Promise<void> {
  await sendAndLog(athleteId, chatId, question.prompt);
}

/**
 * Routes an inbound text message through the onboarding state machine.
 *
 * Returns true  — message was handled (onboarding in progress or just finished this turn).
 * Returns false — onboarding is already complete; caller should route elsewhere.
 */
export async function handleOnboardingMessage(
  ctx: Context,
  athlete: AthleteRow
): Promise<boolean> {
  const athleteId = athlete.id;
  const chatId = ctx.chat!.id;
  const text = ctx.message?.text ?? "";

  await logInbound(athleteId, text);

  const state = await loadOnboardingState(athleteId);

  // Onboarding already complete
  if (state.step >= onboardingSteps.length) return false;

  const step = onboardingSteps[state.step];
  if (!step) return false;

  const questionIdx = firstActiveQuestion(step.questions, state.question, state.partial);

  // All remaining questions in this step are skipped — complete immediately
  if (questionIdx === -1) {
    return await completeStep(athleteId, chatId, state);
  }

  const question = step.questions[questionIdx];
  if (!question) return false;

  const result = question.parseReply(text, state.partial);

  if (!result.ok) {
    await sendAndLog(
      athleteId,
      chatId,
      `${result.error}\n\n${question.prompt}`
    );
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
  state: OnboardingState
): Promise<boolean> {
  const nextStepIdx = state.step + 1;

  if (nextStepIdx < onboardingSteps.length) {
    const nextStep = onboardingSteps[nextStepIdx];
    if (!nextStep) return false;

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

  // REPLACE-IN-PROMPT-11
  await sendAndLog(
    athleteId,
    chatId,
    "Step 1 complete. Steps 2–5 ship in a later update. Type /restart to go again."
  );

  return false;
}
