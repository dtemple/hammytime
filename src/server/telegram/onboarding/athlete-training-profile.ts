import { supabaseAdmin } from '@/lib/db';
import type { Database } from '@/lib/db-types';

export type TrainingProfileRow =
  Database['public']['Tables']['athlete_training_profile']['Row'];
export type TrainingProfileInsert =
  Database['public']['Tables']['athlete_training_profile']['Insert'];

export type GoalType = NonNullable<TrainingProfileRow['goal_type']>;
export type GoalState = NonNullable<TrainingProfileRow['goal_state']>;
export type ExperienceTier = NonNullable<TrainingProfileRow['experience_tier']>;
export type GoalDistance = NonNullable<TrainingProfileRow['goal_distance']>;

/**
 * Upsert the athlete's structured training profile (onboarding v2).
 * athlete_id is the PK, so re-onboarding overwrites cleanly. Pass only the
 * fields a step owns; merged over any existing row.
 */
export async function upsertTrainingProfile(
  athleteId: string,
  patch: Partial<Omit<TrainingProfileInsert, 'athlete_id'>>,
): Promise<void> {
  const db = supabaseAdmin();

  const { data: existing } = await db
    .from('athlete_training_profile')
    .select('*')
    .eq('athlete_id', athleteId)
    .maybeSingle();

  // goal-setup writes the NOT NULL fields (goal_type/goal_state) first; later steps
  // merge their fields over the existing row.
  const merged = {
    ...(existing ?? {}),
    ...patch,
    athlete_id: athleteId,
    updated_at: new Date().toISOString(),
  } as TrainingProfileInsert;

  const { error } = await db
    .from('athlete_training_profile')
    .upsert(merged, { onConflict: 'athlete_id' });

  if (error) throw new Error(`upsertTrainingProfile failed: ${error.message}`);
}

export async function getTrainingProfile(
  athleteId: string,
): Promise<TrainingProfileRow | null> {
  const { data } = await supabaseAdmin()
    .from('athlete_training_profile')
    .select('*')
    .eq('athlete_id', athleteId)
    .maybeSingle();
  return data ?? null;
}
