// GF-W1 — open-ended plan extension orchestration.
//
// Called by the worker at the start of a daily_checkin job (before hydrate):
// when a keep_fit athlete (or intended with no bound race) has ≤ EXTENSION_
// HORIZON_DAYS of plan left, re-render a continuation block through the
// template renderer, merge it onto the working plan, and auto-publish it as
// the new current AND baseline version (record_plan_extension RPC). This is
// the system keeping its promise of a rolling plan, not a coaching change —
// no confirm tap (GF-W1 decision (a)).
//
// Lives in src/server (not worker/) because GF-W3's [Keep me fit] rollover
// callback runs Vercel-side and reuses this render-and-publish machinery.

import { supabaseAdmin } from '@/lib/db';
import type { Json } from '@/lib/db-types';
import { PlanSchema, type Plan } from '@/lib/plan-schema';
import {
  selectPlan,
  renderPlan,
  validateSafety,
  continuationStart,
  futureDatedDayCount,
  mergeContinuation,
  snapshotFromPlan,
  DRAFT_SAFETY_CAPS,
} from '@/lib/plan-templates';
import { getFitnessSnapshot } from '@/server/strava/activities';
import { enqueueJob } from '@/server/jobs/enqueue';
import {
  buildSelectorProfile,
  toFitnessSnapshotInput,
  todayInTz,
} from '@/server/telegram/onboarding/plan-gen';
import { getTrainingProfile } from '@/server/telegram/onboarding/athlete-training-profile';

// Trigger when this many or fewer dated plan days remain. Two weeks of slack
// means one missed/failed extension still leaves runway to fix it.
export const EXTENSION_HORIZON_DAYS = 14;

export type ExtensionResult = {
  extended: true;
  versionId: string;
  newEndDate: string;
  blockWeeks: number;
  /** Only set on dry runs — the merged plan that WOULD have been published. */
  mergedPlan?: Plan;
};

/**
 * Extend the athlete's open-ended plan if it's running out of future days.
 * Returns null when nothing was done (not eligible, plan healthy, no plan);
 * throws on a real failure (render/merge/RPC) — the caller decides how loud
 * to be, the daily run proceeds either way.
 *
 * `dryRun` (scripts/dry-run-plan-extend.ts) runs the full detect → render →
 * merge → validate path but skips the publish and calendar enqueue;
 * `horizonDays` overrides the trigger threshold (the script uses it to
 * exercise the render path on a plan that isn't exhausted yet).
 */
export async function extendPlanIfDue(
  athleteId: string,
  opts: { dryRun?: boolean; horizonDays?: number } = {},
): Promise<ExtensionResult | null> {
  // Eligibility: open-ended athletes only. A committed race ends the plan on
  // purpose; GF-W3 owns what happens after it.
  const profile = await getTrainingProfile(athleteId);
  const eligible =
    profile?.goal_state === 'day_to_day' ||
    (profile?.goal_state === 'intended' && !profile.goal_race_id);
  if (!eligible) return null;

  const working = await loadWorkingPlan(athleteId);
  if (!working) return null;

  const db = supabaseAdmin();
  const { data: athleteRow } = await db
    .from('athletes')
    .select('timezone')
    .eq('id', athleteId)
    .maybeSingle();
  const today = todayInTz(athleteRow?.timezone ?? 'America/Los_Angeles');

  const remaining = futureDatedDayCount(working.plan, today);
  if (remaining === null) {
    console.warn(`[plan-extend] ${athleteId}: plan has no resolvable dates — skipping`);
    return null;
  }
  if (remaining > (opts.horizonDays ?? EXTENSION_HORIZON_DAYS)) return null;

  const start = continuationStart(working.plan, today);
  if (!start) return null;

  // Profile anchored on the continuation start. An intended athlete's stale
  // (past) target_date would otherwise clamp the render to a degenerate
  // 1-week block — null it so the render goes open-ended.
  const selectorProfile = await buildSelectorProfile(athleteId, start.startDate);
  if (selectorProfile.targetDate && selectorProfile.targetDate < start.startDate) {
    selectorProfile.targetDate = null;
  }

  // Fresh Strava snapshot so the continuation starts at current fitness. When
  // Strava is disconnected/broken (null or throw), seed from the working
  // plan's recent weeks instead of letting the selector floor a trained-up
  // athlete back to the template start volume.
  let snapshot = null;
  try {
    snapshot = toFitnessSnapshotInput(await getFitnessSnapshot(athleteId));
  } catch (err) {
    console.warn(`[plan-extend] ${athleteId}: Strava snapshot failed, seeding from plan:`, err);
  }
  snapshot ??= snapshotFromPlan(working.plan);

  const { template, params } = selectPlan(selectorProfile, snapshot, DRAFT_SAFETY_CAPS);
  params.easeIn = start.easeIn;
  // The strength opt-out ([No strength] at B1) lives only in the plan JSON,
  // not the profile — carry it forward or the continuation re-adds strength.
  const workingStrength = working.plan.metadata.plan_structure.strength_sessions_per_week;
  if (workingStrength === 0 || workingStrength === 1 || workingStrength === 2) {
    params.strengthSessionsPerWeek = workingStrength;
  }

  const continuation = renderPlan(template, params);
  const merged = mergeContinuation(working.plan, continuation);

  // Same warn-don't-block posture as generateAndPersistPlan; the seam ramp
  // (old final week → continuation week 1) is covered by the merged check.
  const safety = validateSafety(merged, DRAFT_SAFETY_CAPS, selectorProfile.goalDistance);
  if (!safety.ok) {
    console.warn(
      `[plan-extend] validateSafety found ${safety.violations.length} violation(s) for ${athleteId}:`,
      JSON.stringify(safety.violations),
    );
  }

  const blockWeeks = continuation.weeks.length;
  const newEndDateOf = (p: Plan): string =>
    p.metadata.plan_structure.end_date ?? p.weeks[p.weeks.length - 1]?.end_date ?? start.startDate;

  if (opts.dryRun) {
    return {
      extended: true,
      versionId: 'dry-run',
      newEndDate: newEndDateOf(merged),
      blockWeeks,
      mergedPlan: merged,
    };
  }

  const { data: versionId, error } = await db.rpc('record_plan_extension', {
    p_plan_id: working.planId,
    p_plan_json: merged as unknown as Json,
    p_supersedes_version_id: working.versionId,
    p_total_weeks: merged.weeks.length,
    p_start_date: merged.metadata.plan_structure.start_date,
  });
  if (error || !versionId) {
    throw new Error(`record_plan_extension failed for ${athleteId}: ${error?.message}`);
  }

  // Connected-Google athletes get the new weeks same-day (the morning message
  // announces them). Inlined oauth check + enqueue rather than importing
  // enqueueCalendarSyncIfConnected: that module pulls in @sentry/nextjs, which
  // the worker process deliberately never loads.
  try {
    const { data: tok } = await db
      .from('oauth_tokens')
      .select('id')
      .eq('athlete_id', athleteId)
      .eq('provider', 'google_calendar')
      .maybeSingle();
    if (tok) {
      await enqueueJob('calendar_sync', `calsync-${athleteId}-${versionId}-${Date.now()}`, {
        athlete_id: athleteId,
        reason: 'plan_extend',
      });
    }
  } catch (err) {
    console.error(`[plan-extend] calendar_sync enqueue failed for ${athleteId}:`, err);
  }

  const newEndDate = newEndDateOf(merged);
  console.log(
    `[plan-extend] ${athleteId}: extended +${blockWeeks} weeks through ${newEndDate} (version ${versionId})`,
  );
  return { extended: true, versionId, newEndDate, blockWeeks };
}

/** The athlete's working plan: latest plans row + its current version JSON.
 *  Unlike getActiveTemplatePlan this accepts coach-edited versions — the
 *  extension appends to whatever the athlete is actually training on. */
async function loadWorkingPlan(
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
    .select('id, plan_json, status')
    .eq('id', planRow.current_version_id)
    .maybeSingle();
  if (!v || v.status !== 'active' || !v.plan_json) return null;

  const parsed = PlanSchema.safeParse(v.plan_json);
  if (!parsed.success) {
    console.warn(`[plan-extend] ${athleteId}: current version ${v.id} fails PlanSchema — skipping`);
    return null;
  }
  return { planId: planRow.id, versionId: v.id, plan: parsed.data };
}
