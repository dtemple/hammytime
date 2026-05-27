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

export async function resetOnboarding(athleteId: string): Promise<void> {
  const { error } = await supabaseAdmin().rpc('set_onboarding_state', {
    p_athlete_id: athleteId,
    p_new_state: INITIAL_STATE,
  });
  if (error) throw new Error(`resetOnboarding failed: ${error.message}`);
}
