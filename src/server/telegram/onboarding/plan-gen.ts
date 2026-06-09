// Onboarding v2 (W4): the wiring boundary between the deterministic template
// engine (src/lib/plan-templates) and the live onboarding route.
//
// lib/ can't import server/, so the snake→camel snapshot adapter, the
// SelectorProfile builder (reads athlete_training_profile + the goal race +
// injuries), and the generate/persist helper all live here. The rendered plan
// is persisted as a `plan_versions` row and set as BOTH the immutable
// baseline_version_id and the initial working current_version_id — the coach's
// `[Adjust it]` edits later supersede the working version (via record_plan_edit)
// while the template baseline stays put. Deterministic, no LLM, inline.

import { supabaseAdmin } from '@/lib/db';
import { enqueueCalendarSyncIfConnected } from '@/server/google/enqueue-sync';
import { PlanSchema, type Plan } from '@/lib/plan-schema';
import {
  selectPlan,
  renderPlan,
  validateSafety,
  DRAFT_SAFETY_CAPS,
  type FitnessSnapshotInput,
  type SelectorProfile,
  type RenderParams,
  type Terrain,
  type GoalDistance,
  type TargetType,
} from '@/lib/plan-templates';
import {
  getFitnessSnapshot,
  type StravaFitnessSnapshot,
} from '@/server/strava/activities';
import { getTrainingProfile } from './athlete-training-profile';

export type GeneratedPlan = {
  planId: string;
  versionId: string;
  plan: Plan;
  params: RenderParams;
};

// Nominal race miles per distance — only a fallback when a committed race row is
// missing distance_mi (the engine has its own copy for the placeholder race).
const NOMINAL_MILES: Record<GoalDistance, number> = {
  '5k': 3.1,
  '10k': 6.2,
  half: 13.1,
  marathon: 26.2,
  keep_fit: 5,
};

/** snake_case StravaFitnessSnapshot → camelCase FitnessSnapshotInput (the
 *  structural shape the selector consumes). Null passes through. */
export function toFitnessSnapshotInput(
  snap: StravaFitnessSnapshot | null,
): FitnessSnapshotInput | null {
  if (!snap) return null;
  return {
    recentWeeklyMileageMi: snap.recent_weekly_mileage_mi,
    avgWeeklyMileageMi: snap.avg_weekly_mileage_mi,
    longestRunMi: snap.longest_run_mi,
    runsPerWeek: snap.runs_per_week,
    suggestedDaysPerWeek: snap.suggested_days_per_week,
    dominantLongRunWeekday: snap.dominant_long_run_weekday,
    roadTrailMix: snap.road_trail_mix,
  };
}

function normalizeTerrain(terrain: string | null): Terrain {
  const s = (terrain ?? '').toLowerCase();
  if (s.includes('trail')) return 'trail';
  if (s.includes('mixed')) return 'mixed';
  return 'road';
}

/** Today's date (ISO yyyy-mm-dd) in the athlete's timezone. en-CA formats as
 *  yyyy-mm-dd. */
export function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function athleteTimezone(athleteId: string): Promise<string> {
  const { data } = await supabaseAdmin()
    .from('athletes')
    .select('timezone')
    .eq('id', athleteId)
    .maybeSingle();
  return data?.timezone ?? 'America/Los_Angeles';
}

/**
 * Reads the W2 training profile + the committed goal race + injuries and maps
 * them to the engine's SelectorProfile. `today` is the athlete-local ISO date.
 * Enum columns are typed `string` in db-types but CHECK-constrained in the DB,
 * so the narrowing casts are safe.
 */
export async function buildSelectorProfile(
  athleteId: string,
  today: string,
): Promise<SelectorProfile> {
  const db = supabaseAdmin();
  const profile = await getTrainingProfile(athleteId);
  if (!profile) {
    throw new Error(`buildSelectorProfile: no training profile for ${athleteId}`);
  }
  if (!profile.experience_tier || !profile.goal_distance) {
    throw new Error(
      `buildSelectorProfile: incomplete profile for ${athleteId} (tier/distance missing)`,
    );
  }

  const goalDistance = profile.goal_distance as GoalDistance;

  let race: SelectorProfile['race'] = null;
  let targetType: TargetType = 'finish';
  let targetTimeSec: number | null = null;

  if (profile.goal_race_id) {
    const { data: r } = await db
      .from('races')
      .select('name, date, distance_mi, elevation_ft, terrain, target_type, target_time_sec')
      .eq('id', profile.goal_race_id)
      .maybeSingle();
    if (r) {
      targetType = r.target_type === 'time' ? 'time' : 'finish';
      targetTimeSec = r.target_time_sec ?? null;
      race = {
        name: r.name,
        date: r.date ?? profile.target_date ?? today,
        distanceMiles: r.distance_mi ?? NOMINAL_MILES[goalDistance],
        elevationGainFt: r.elevation_ft ?? undefined,
        type: normalizeTerrain(r.terrain),
      };
    }
  }

  const { data: injuryRows } = await db
    .from('injuries')
    .select('body_part')
    .eq('athlete_id', athleteId);

  return {
    experienceTier: profile.experience_tier as SelectorProfile['experienceTier'],
    goalDistance,
    daysPerWeek: profile.days_per_week ?? 4,
    longRunDay: profile.long_run_day ?? 0,
    goalState: profile.goal_state as SelectorProfile['goalState'],
    targetDate: profile.target_date ?? null,
    targetType,
    targetTimeSec,
    race,
    injuries: (injuryRows ?? []).map((i) => ({ bodyPart: i.body_part })),
    today,
  };
}

/**
 * Renders the template plan and persists it, returning the row ids + plan +
 * params. Idempotent: if an active template plan already exists for the athlete
 * (a webhook/callback retry re-entering B1), it is reused rather than inserting
 * a duplicate.
 */
export async function generateAndPersistPlan(athleteId: string): Promise<GeneratedPlan> {
  const today = todayInTz(await athleteTimezone(athleteId));
  const profile = await buildSelectorProfile(athleteId, today);
  const snapshot = toFitnessSnapshotInput(await getFitnessSnapshot(athleteId));
  const { template, params } = selectPlan(profile, snapshot, DRAFT_SAFETY_CAPS);

  const existing = await getActiveTemplatePlan(athleteId);
  if (existing) {
    return { ...existing, params };
  }

  const plan = renderPlan(template, params);
  const safety = validateSafety(plan, DRAFT_SAFETY_CAPS, profile.goalDistance);
  if (!safety.ok) {
    console.warn(
      `[plan-gen] validateSafety found ${safety.violations.length} violation(s) for ${athleteId}:`,
      JSON.stringify(safety.violations),
    );
  }

  const { planId, versionId } = await persistTemplatePlan(athleteId, plan);
  // A connected athlete re-onboarding gets the fresh plan on their Google
  // calendar; for the common first-time case (no connection yet) this no-ops.
  await enqueueCalendarSyncIfConnected(athleteId, 'plan_gen', versionId);
  return { planId, versionId, plan, params };
}

/**
 * Re-renders the plan with strength removed (the B1 `[No strength]` opt-out) and
 * overwrites the onboarding template version in place. Safe because that version
 * is onboarding-owned — no coach has edited it yet, so there is no baseline to
 * protect and no working-version chain to fork.
 */
export async function setPlanStrengthToZero(
  athleteId: string,
  versionId: string,
): Promise<{ plan: Plan; params: RenderParams }> {
  const today = todayInTz(await athleteTimezone(athleteId));
  const profile = await buildSelectorProfile(athleteId, today);
  const snapshot = toFitnessSnapshotInput(await getFitnessSnapshot(athleteId));
  const { template, params } = selectPlan(profile, snapshot, DRAFT_SAFETY_CAPS);
  params.strengthSessionsPerWeek = 0;

  const plan = renderPlan(template, params);
  const { error } = await supabaseAdmin()
    .from('plan_versions')
    .update({ plan_json: plan })
    .eq('id', versionId);
  if (error) throw new Error(`setPlanStrengthToZero: update failed: ${error.message}`);

  // The in-place plan_json overwrite changes calendar content without moving
  // current_version_id — it needs its own sync trigger.
  await enqueueCalendarSyncIfConnected(athleteId, 'strength_zero', versionId);

  return { plan, params };
}

/**
 * Looks up the athlete's active template plan (the version persisted at B1).
 * Used by the preview callbacks (`[Adjust it]` needs the version id for the
 * job dedup key; `[No strength]` re-renders against it) and as the idempotency
 * guard inside generateAndPersistPlan. Returns null if no active template
 * version exists yet.
 */
export async function getActiveTemplatePlan(
  athleteId: string,
): Promise<{ planId: string; versionId: string; plan: Plan } | null> {
  const db = supabaseAdmin();
  const { data: planRow } = await db
    .from('plans')
    .select('id, current_version_id')
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!planRow?.current_version_id) return null;

  const { data: v } = await db
    .from('plan_versions')
    .select('id, plan_json, generated_by, status')
    .eq('id', planRow.current_version_id)
    .maybeSingle();
  if (!v || v.generated_by !== 'template' || v.status !== 'active' || !v.plan_json) {
    return null;
  }

  const parsed = PlanSchema.safeParse(v.plan_json);
  if (!parsed.success) return null;
  return { planId: planRow.id, versionId: v.id, plan: parsed.data };
}

async function persistTemplatePlan(
  athleteId: string,
  plan: Plan,
): Promise<{ planId: string; versionId: string }> {
  const db = supabaseAdmin();
  const profile = await getTrainingProfile(athleteId);
  const startDate = plan.metadata.plan_structure.start_date;

  const { data: planRow, error: planErr } = await db
    .from('plans')
    .insert({
      athlete_id: athleteId,
      goal_race_id: profile?.goal_race_id ?? null,
      start_date: startDate,
      weeks: plan.weeks.length,
      current_version_id: null,
    })
    .select('id')
    .single();
  if (planErr || !planRow) {
    throw new Error(`persistTemplatePlan: plans insert failed: ${planErr?.message}`);
  }

  const { data: versionRow, error: versionErr } = await db
    .from('plan_versions')
    .insert({
      plan_id: planRow.id,
      version: 1,
      plan_json: plan,
      schema_version: 1,
      generated_by: 'template',
      status: 'active',
    })
    .select('id')
    .single();
  if (versionErr || !versionRow) {
    throw new Error(`persistTemplatePlan: plan_versions insert failed: ${versionErr?.message}`);
  }

  // The template version is both the immutable baseline and the initial working
  // version. The coach's [Adjust it] edits later supersede current_version_id
  // (via record_plan_edit) and leave baseline_version_id untouched → drift.
  const { error: updErr } = await db
    .from('plans')
    .update({
      current_version_id: versionRow.id,
      baseline_version_id: versionRow.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', planRow.id);
  if (updErr) {
    throw new Error(`persistTemplatePlan: plans update failed: ${updErr.message}`);
  }

  return { planId: planRow.id, versionId: versionRow.id };
}
