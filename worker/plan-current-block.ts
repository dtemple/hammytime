// The current-block plan view (Specs/CHANGELOG.md v0.7.41).
//
// A read-only, future-weighted slice of the full marathon_training_plan.json the
// coach reads for routine work instead of loading the whole ~14k-token plan every
// run. Same derived-file pattern as plan_drift.md: built at hydrate (folder.ts),
// written as plan_view_readonly.json, never synced back, never edited. The full
// plan is always one Read away — the coach opens it for any whole-arc /
// look-back question and for every edit.
//
// The view is asymmetric, weighted toward the future:
//   - metadata, agent_guidance, strength_workouts kept WHOLE (pace zones,
//     compliance rules, race facts, strength session content).
//   - FULL day-level detail for the current week + next 2 weeks (the acting
//     window), plus any near-horizon race's week and its lead-in weeks.
//   - Future beyond the window: one skeleton line per week.
//   - Past: a single rolled-up summary line, plus the immediately-preceding week
//     as a skeleton tail for continuity (past prescribed detail is redundant —
//     actuals come from strava_recent.json, plan movement from plan_drift.md).
//   - An always-complete races list (every type:"race" day across the whole plan
//     plus the non-placeholder goal race), so a tune-up several weeks out is
//     never reduced to a skeleton line and the coach can build a taper into it.
//
// This module is pure and total: no I/O, and it never throws on an odd-but-valid
// plan, so a malformed plan degrades to no view in folder.ts rather than failing
// the run.

import { isPlaceholderRace, type Plan, type Week } from '@/lib/plan-schema';

// Current week + next 2 = 3 weeks of full day-level detail.
const ACTING_WINDOW_WEEKS = 3;
// A race within this many days of today pulls its week + lead-in into full
// detail so the taper is visible without opening the full plan.
const NEAR_HORIZON_DAYS = 42; // 6 weeks
// Weeks before a near-horizon race also pulled to full detail (the taper lead-in).
const LEAD_IN_WEEKS = 2;

const READONLY_NOTE =
  'READ-ONLY derived view for routine work. Never edit this file. Open ' +
  'marathon_training_plan.json for any whole-arc or look-back question and for ' +
  'every plan edit — the full plan is always one Read away.';

// A skeleton week: phase + planned miles + bounds, no day detail.
type SkeletonWeek = {
  week_number: number;
  phase: string;
  planned_total_run_miles: number;
  start_date?: string;
  end_date?: string;
  coaching_note?: string;
  skeleton: true;
};

// A full week is the verbatim plan Week object (with days[]).
type ViewWeek = Week | SkeletonWeek;

type RaceEntry = {
  date?: string;
  name?: string;
  description?: string;
  distance_miles?: number;
  week_number?: number;
  phase?: string;
  is_goal_race: boolean;
};

export type CurrentBlockView = {
  _readonly: string;
  today: string;
  // The week the athlete is in now, or null when today is past the plan's end.
  current_week: number | null;
  metadata: Plan['metadata'];
  agent_guidance?: Plan['agent_guidance'];
  strength_workouts?: Plan['strength_workouts'];
  races: RaceEntry[];
  past_summary?: string;
  weeks: ViewWeek[];
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// A week's planned running miles: its own field if set, else summed from days.
function weekPlannedMiles(w: Week): number {
  if (w.planned_total_run_miles != null) return round1(w.planned_total_run_miles);
  return round1(w.days.reduce((sum, d) => sum + (d.planned_distance_miles ?? 0), 0));
}

function datedDays(w: Week): string[] {
  return w.days
    .map((d) => d.date)
    .filter((d): d is string => d !== undefined)
    .sort();
}

function weekStart(w: Week): string | undefined {
  return w.start_date ?? datedDays(w)[0];
}

function weekEnd(w: Week): string | undefined {
  return w.end_date ?? datedDays(w).at(-1);
}

// YYYY-MM-DD `n` days after `iso` (UTC math — dates are zone-free here).
function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function weekIndexContaining(sorted: Week[], date: string): number | undefined {
  for (let i = 0; i < sorted.length; i++) {
    const start = weekStart(sorted[i]!);
    const end = weekEnd(sorted[i]!);
    if (start && end && start <= date && date <= end) return i;
  }
  return undefined;
}

function skeletonWeek(w: Week): SkeletonWeek {
  return {
    week_number: w.week_number,
    phase: w.phase,
    planned_total_run_miles: weekPlannedMiles(w),
    ...(weekStart(w) !== undefined ? { start_date: weekStart(w) } : {}),
    ...(weekEnd(w) !== undefined ? { end_date: weekEnd(w) } : {}),
    ...(w.coaching_note ? { coaching_note: w.coaching_note } : {}),
    skeleton: true,
  };
}

function buildRaces(sorted: Week[], plan: Plan): RaceEntry[] {
  const races: RaceEntry[] = [];
  for (const w of sorted) {
    for (const d of w.days) {
      if (d.type !== 'race') continue;
      races.push({
        date: d.date,
        description: d.description,
        distance_miles: d.planned_distance_miles,
        week_number: w.week_number,
        phase: w.phase,
        is_goal_race: false,
      });
    }
  }

  // The goal race (metadata.race) — unless it's the schema-required synthetic
  // placeholder on a no-event / intended-no-date plan, which the coach never sees.
  const goal = plan.metadata.race;
  if (!isPlaceholderRace(goal)) {
    const onDay = races.find((r) => r.date && r.date === goal.date);
    if (onDay) {
      // A race day already covers this date — mark it as the goal, keep one entry.
      onDay.is_goal_race = true;
      onDay.name = goal.name;
    } else {
      const wi = weekIndexContaining(sorted, goal.date);
      races.push({
        date: goal.date,
        name: goal.name,
        distance_miles: goal.distance_miles,
        week_number: wi !== undefined ? sorted[wi]!.week_number : undefined,
        phase: wi !== undefined ? sorted[wi]!.phase : undefined,
        is_goal_race: true,
      });
    }
  }

  return races.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

function buildPastSummary(sorted: Week[], pastIndices: number[]): string | undefined {
  if (pastIndices.length === 0) return undefined;
  const first = sorted[pastIndices[0]!]!;
  const last = sorted[pastIndices.at(-1)!]!;
  const phaseSpan = first.phase === last.phase ? first.phase : `${first.phase} → ${last.phase}`;
  const avg = round1(
    pastIndices.reduce((s, i) => s + weekPlannedMiles(sorted[i]!), 0) / pastIndices.length,
  );
  const n = pastIndices.length;
  return `Weeks ${first.week_number}–${last.week_number} (${phaseSpan}): ${n} week${n > 1 ? 's' : ''}, avg ${avg} mi/wk planned.`;
}

/**
 * Builds the current-block view from a validated plan and today's date
 * (YYYY-MM-DD, athlete-local). Pure and total.
 */
export function buildCurrentBlock(plan: Plan, today: string): CurrentBlockView {
  const sorted = [...plan.weeks].sort((a, b) => a.week_number - b.week_number);
  const idxByNum = new Map(sorted.map((w, i) => [w.week_number, i]));

  // The current week is the first whose end is today or later. A plan that can't
  // be positioned by date (no week or day dates anywhere) shows from its start;
  // a plan whose every week has ended leaves current_week null (today past race).
  const positioned = sorted.some((w) => (weekEnd(w) ?? weekStart(w)) !== undefined);
  let currentIdx: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const end = weekEnd(sorted[i]!) ?? weekStart(sorted[i]!);
    if (end && end >= today) {
      currentIdx = i;
      break;
    }
  }
  if (currentIdx === null && !positioned) currentIdx = sorted.length > 0 ? 0 : null;
  const currentWeek = currentIdx !== null ? sorted[currentIdx]!.week_number : null;

  // Full-detail index set: the acting window from the current week forward...
  const fullDetail = new Set<number>();
  if (currentIdx !== null) {
    const last = Math.min(sorted.length, currentIdx + ACTING_WINDOW_WEEKS);
    for (let i = currentIdx; i < last; i++) fullDetail.add(i);
  }

  const races = buildRaces(sorted, plan);

  // ...plus each near-horizon race's week and its lead-in weeks, so an upcoming
  // tune-up's taper is visible at full detail without opening the full plan.
  const horizonEnd = addDays(today, NEAR_HORIZON_DAYS);
  for (const r of races) {
    if (!r.date || r.date < today || r.date > horizonEnd) continue;
    const wi =
      r.week_number !== undefined ? idxByNum.get(r.week_number) : weekIndexContaining(sorted, r.date);
    if (wi === undefined) continue;
    for (let i = Math.max(0, wi - LEAD_IN_WEEKS); i <= wi; i++) fullDetail.add(i);
  }

  // The immediately-preceding week stays as a skeleton tail for continuity; when
  // the plan is over (no current week) the last week is that tail.
  const tailIdx = currentIdx !== null ? currentIdx - 1 : sorted.length - 1;

  const weeks: ViewWeek[] = [];
  const pastIndices: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i]!;
    if (fullDetail.has(i)) {
      weeks.push(w); // verbatim full week
    } else if (i === tailIdx && tailIdx >= 0) {
      weeks.push(skeletonWeek(w));
    } else if (tailIdx >= 0 && i < tailIdx) {
      pastIndices.push(i);
    } else {
      weeks.push(skeletonWeek(w)); // future, beyond the window
    }
  }

  return {
    _readonly: READONLY_NOTE,
    today,
    current_week: currentWeek,
    metadata: plan.metadata,
    ...(plan.agent_guidance !== undefined ? { agent_guidance: plan.agent_guidance } : {}),
    ...(plan.strength_workouts !== undefined ? { strength_workouts: plan.strength_workouts } : {}),
    races,
    ...(buildPastSummary(sorted, pastIndices) !== undefined
      ? { past_summary: buildPastSummary(sorted, pastIndices) }
      : {}),
    weeks,
  };
}
