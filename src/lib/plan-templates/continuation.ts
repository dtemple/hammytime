// GF-W1 — pure continuation logic for open-ended plan extension.
//
// When a keep_fit (or intended-no-race) athlete's rolling plan runs low on
// future days, the worker re-renders a fresh block via selectPlan/renderPlan
// and appends it to the working plan. Everything here is deterministic and
// IO-free: counting the horizon, picking the continuation start, merging the
// rendered block into the existing plan JSON, and deriving a fitness snapshot
// from the plan itself when Strava can't provide one. The orchestration (DB
// reads, render, publish) lives in src/server/plan/extend.ts.

import { PlanSchema, isPlaceholderRace, type Plan, type Week } from '../plan-schema';
import { addDays, mondayOf } from './dates';
import type { FitnessSnapshotInput } from './selector';

/** Resolve a day's calendar date: the explicit field, else positional from the
 *  week's start_date — the same fallback calendar-events.ts uses. */
function dayDate(week: Week, dayIndex: number): string | null {
  const d = week.days[dayIndex];
  if (d?.date) return d.date;
  if (week.start_date) return addDays(week.start_date, dayIndex);
  return null;
}

/** The latest resolvable calendar date in the plan, or null if no day has one
 *  (a hand-written plan with no dates anywhere — not extendable). */
export function lastDatedDay(plan: Plan): string | null {
  let last: string | null = null;
  for (const week of plan.weeks) {
    for (let i = 0; i < week.days.length; i++) {
      const date = dayDate(week, i);
      if (date && (last === null || date > last)) last = date;
    }
  }
  return last;
}

/** How many plan days lie strictly after `todayISO`. Null when the plan has no
 *  resolvable dates at all (callers should skip extension, not treat as 0). */
export function futureDatedDayCount(plan: Plan, todayISO: string): number | null {
  let any = false;
  let count = 0;
  for (const week of plan.weeks) {
    for (let i = 0; i < week.days.length; i++) {
      const date = dayDate(week, i);
      if (!date) continue;
      any = true;
      if (date > todayISO) count++;
    }
  }
  return any ? count : null;
}

export type ContinuationStart = { startDate: string; easeIn: boolean };

/**
 * Where the continuation block begins. Normal case: the first Monday strictly
 * after the plan's last dated day, rendered as a full week (easeIn false — see
 * RenderParams.easeIn). If the plan is already exhausted (that Monday is in
 * the past), start from today with ease-in ON, so the elapsed part of the
 * current week is rested instead of carrying phantom prescriptions.
 */
export function continuationStart(plan: Plan, todayISO: string): ContinuationStart | null {
  const last = lastDatedDay(plan);
  if (!last) return null;
  // First Monday strictly after the last dated day (mondayOf(last+1) can land
  // on or before `last` when the plan doesn't end on a Sunday).
  let firstMonday = mondayOf(addDays(last, 1));
  if (firstMonday <= last) firstMonday = addDays(firstMonday, 7);
  if (firstMonday >= todayISO) return { startDate: firstMonday, easeIn: false };
  return { startDate: todayISO, easeIn: true };
}

function clonePlan(p: Plan): Plan {
  return JSON.parse(JSON.stringify(p)) as Plan;
}

/**
 * Append a freshly rendered continuation block onto the existing working plan.
 * Existing weeks are untouched (calendar UIDs key on plan id + week_number, so
 * past events must not move); continuation weeks are renumbered to follow on,
 * phases are offset the same way, and the placeholder race's date — which
 * tracks the plan end — moves to the new end. Top-level guidance, strength
 * library, and athlete block stay the existing plan's (the continuation render
 * already respected the working strength opt-out via params).
 *
 * Throws (via PlanSchema.parse) if the merge doesn't produce a valid plan.
 */
export function mergeContinuation(existing: Plan, continuation: Plan): Plan {
  const merged = clonePlan(existing);
  const offset = Math.max(...existing.weeks.map((w) => w.week_number));

  const contWeeks = clonePlan(continuation).weeks.map((w) => ({
    ...w,
    week_number: w.week_number + offset,
  }));
  merged.weeks = [...merged.weeks, ...contWeeks];

  const structure = merged.metadata.plan_structure;
  structure.total_weeks = merged.weeks.length;
  const lastWeek = merged.weeks[merged.weeks.length - 1]!;
  if (lastWeek.end_date) structure.end_date = lastWeek.end_date;

  // Phases must cover 1..total_weeks exactly once when present. Merge only if
  // both sides carry them; otherwise drop the section rather than emit a
  // partial cover that fails the schema refinement.
  const existingPhases = existing.metadata.plan_structure.phases;
  const contPhases = continuation.metadata.plan_structure.phases;
  if (existingPhases?.length && contPhases?.length) {
    structure.phases = [
      ...existingPhases,
      ...contPhases.map((p) => ({ ...p, weeks: p.weeks.map((w) => w + offset) })),
    ];
  } else {
    delete structure.phases;
  }

  if (isPlaceholderRace(merged.metadata.race)) {
    merged.metadata.race.date = structure.end_date ?? merged.metadata.race.date;
    // Upgrade pre-flag plans so downstream surfaces can rely on the flag.
    merged.metadata.race.placeholder = true;
  }

  return PlanSchema.parse(merged);
}

/**
 * Fitness snapshot derived from the working plan's recent prescriptions — the
 * fallback when Strava is disconnected/broken at extension time. Without it
 * the selector would floor a trained-up athlete back to the template's start
 * volume. Reads the last `lookbackWeeks` non-cutback weeks (prescribed, not
 * proven — but far closer to reality than the floor).
 */
export function snapshotFromPlan(plan: Plan, lookbackWeeks = 4): FitnessSnapshotInput | null {
  const candidates = plan.weeks.filter(
    (w) => w.phase !== 'cutback' && typeof w.planned_total_run_miles === 'number',
  );
  const recent = (candidates.length ? candidates : plan.weeks).slice(-lookbackWeeks);
  if (recent.length === 0) return null;

  const totals = recent
    .map((w) => w.planned_total_run_miles)
    .filter((n): n is number => typeof n === 'number');
  if (totals.length === 0) return null;
  const weekly = totals.reduce((s, n) => s + n, 0) / totals.length;

  let longest = 0;
  let runDays = 0;
  for (const w of recent) {
    for (const d of w.days) {
      const miles = d.planned_distance_miles ?? 0;
      if (d.type === 'long_run' && miles > longest) longest = miles;
      if (d.category === 'run' || (miles > 0 && d.type !== 'race')) runDays++;
    }
  }
  const runsPerWeek = runDays / recent.length;

  // Terrain leaning rides through roadTrailMix (deriveTerrain reads it); the
  // working plan's race.type carries the original terrain even on placeholders.
  const terrain = plan.metadata.race.type;
  const roadTrailMix =
    terrain === 'trail'
      ? { road: 0, trail: 1 }
      : terrain === 'mixed'
        ? { road: 1, trail: 1 }
        : { road: 1, trail: 0 };

  return {
    recentWeeklyMileageMi: Math.round(weekly * 10) / 10,
    avgWeeklyMileageMi: Math.round(weekly * 10) / 10,
    longestRunMi: longest,
    runsPerWeek: Math.round(runsPerWeek * 10) / 10,
    suggestedDaysPerWeek: Math.min(6, Math.max(3, Math.round(runsPerWeek))),
    dominantLongRunWeekday: null,
    roadTrailMix,
  };
}
