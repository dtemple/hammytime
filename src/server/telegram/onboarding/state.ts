import { supabaseAdmin } from '@/lib/db';
import type { OnboardingState } from './types';

const INITIAL_STATE: OnboardingState = { step: 0, question: 0, partial: {} };

export async function loadOnboardingState(athleteId: string): Promise<OnboardingState> {
  const { data, error } = await supabaseAdmin()
    .from('athletes')
    .select('onboarding_state')
    .eq('id', athleteId)
    .single();

  if (error || !data) return { ...INITIAL_STATE };

  const raw = data.onboarding_state as Record<string, unknown>;
  return {
    step: typeof raw.step === 'number' ? raw.step : 0,
    question: typeof raw.question === 'number' ? raw.question : 0,
    partial:
      raw.partial && typeof raw.partial === 'object' && !Array.isArray(raw.partial)
        ? (raw.partial as Record<string, unknown>)
        : {},
  };
}

export async function advanceQuestion(athleteId: string, newState: OnboardingState): Promise<void> {
  const { error } = await supabaseAdmin().rpc('set_onboarding_state', {
    p_athlete_id: athleteId,
    p_new_state: newState,
  });
  if (error) throw new Error(`advanceQuestion failed: ${error.message}`);
}

/**
 * Idempotent advance guarded on the current partial.sub_step. Writes the new
 * state only if the stored sub_step equals `expectedSubStep`; returns whether it
 * wrote. Used by the Strava callback resume, which can fire twice (Strava retries).
 */
export async function advanceIfSubstep(
  athleteId: string,
  newState: OnboardingState,
  expectedSubStep: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('set_onboarding_state_if_substep', {
    p_athlete_id: athleteId,
    p_new_state: newState,
    p_expected_substep: expectedSubStep,
  });
  if (error) throw new Error(`advanceIfSubstep failed: ${error.message}`);
  return data === true;
}

export async function resetOnboarding(athleteId: string): Promise<void> {
  const { error } = await supabaseAdmin().rpc('set_onboarding_state', {
    p_athlete_id: athleteId,
    p_new_state: INITIAL_STATE,
  });
  if (error) throw new Error(`resetOnboarding failed: ${error.message}`);
}

/**
 * Full re-onboarding reset. Clears the athlete's onboarding-derived rows (plans,
 * races, injuries, memory files, training profile, pending jobs) and resets
 * onboarding/check-in state in one transaction, so /restart re-runs onboarding
 * from a clean slate instead of duplicating races/injuries. See the
 * reset_athlete_onboarding migration for the exact clear-set.
 */
export async function hardResetOnboarding(athleteId: string): Promise<void> {
  const { error } = await supabaseAdmin().rpc('reset_athlete_onboarding', {
    p_athlete_id: athleteId,
  });
  if (error) throw new Error(`hardResetOnboarding failed: ${error.message}`);
}
