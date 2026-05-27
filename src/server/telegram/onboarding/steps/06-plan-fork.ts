import { supabaseAdmin } from '@/lib/db';
import { handleBuildPath, handleHelpPath } from '@/server/agent/byo-plan';
import type { OnboardingStep, StepHandleResult } from '../types';

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

type Step6Partial = {
  sub_step?: 'choosing_path' | 'awaiting_confirmation';
  chosen?: 'build' | 'help';
};

// ---------------------------------------------------------------------------
// handleMessage
// ---------------------------------------------------------------------------

async function planForkHandleMessage(
  text: string,
  partial: Record<string, unknown>,
  athleteId: string,
): Promise<StepHandleResult> {
  // Short-circuit if the athlete already has a plan. This fires on /restart after
  // Prompt 14b imports a plan, and pre-launch once server-generate ships.
  const db = supabaseAdmin();
  const { data: existingPlan } = await db
    .from('plans')
    .select('id')
    .eq('athlete_id', athleteId)
    .limit(1)
    .maybeSingle();

  if (existingPlan) {
    const { data: existingVersion } = await db
      .from('plan_versions')
      .select('id')
      .eq('plan_id', existingPlan.id)
      .in('status', ['active', 'awaiting_paste'])
      .limit(1)
      .maybeSingle();

    if (existingVersion) {
      return {
        done: true,
        newPartial: {},
        reply: 'Your plan is already loaded — moving on.',
      };
    }
  }

  // No existing plan — run the fork normally.
  const p = partial as Step6Partial;
  const subStep = p.sub_step ?? 'choosing_path';

  if (subStep === 'choosing_path') {
    const v = text.trim().toLowerCase();

    if (v === 'build' || v === 'b') {
      await handleBuildPath(athleteId);
      return {
        done: true,
        newPartial: { sub_step: 'awaiting_confirmation', chosen: 'build' } satisfies Step6Partial,
      };
    }

    if (v === 'help' || v === 'h') {
      await handleHelpPath(athleteId);
      return {
        done: true,
        newPartial: { sub_step: 'awaiting_confirmation', chosen: 'help' } satisfies Step6Partial,
      };
    }

    return {
      done: false,
      newPartial: partial,
      reply: 'Pick one: `build` or `help`.',
    };
  }

  // awaiting_confirmation — no further input expected here
  return { done: false, newPartial: partial };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const INITIAL_PROMPT = [
  "You're set up. Last question: do you already have a plan you're following, or do you want to build one from scratch?",
  '',
  "• `build` — I'll send you a prompt to take to Claude or ChatGPT, you'll work with it to build a plan, then paste the result back to me",
  '• `help` — David handles it personally (allow ~24 hours)',
].join('\n');

export const planForkStep: OnboardingStep = {
  id: 'plan_fork',
  questions: [],
  initialPrompt: INITIAL_PROMPT,
  handleMessage: planForkHandleMessage,
  async onComplete(_athleteId, _partial) {
    // State already advanced inside handleBuildPath / handleHelpPath (or by the dispatcher
    // when short-circuiting). dispatcher.completeStep will also write terminal state — harmless.
  },
};
