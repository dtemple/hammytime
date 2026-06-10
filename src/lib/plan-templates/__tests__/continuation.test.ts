import { describe, it, expect } from 'vitest';
import { PlanSchema, isPlaceholderRace, type Plan } from '@/lib/plan-schema';
import {
  selectPlan,
  renderPlan,
  validateSafety,
  futureDatedDayCount,
  lastDatedDay,
  continuationStart,
  mergeContinuation,
  snapshotFromPlan,
  DRAFT_SAFETY_CAPS,
} from '../index';
import { addDays } from '../dates';
import type { FitnessSnapshotInput, SelectorProfile } from '../selector';

const SNAP: FitnessSnapshotInput = {
  recentWeeklyMileageMi: 26,
  avgWeeklyMileageMi: 24,
  longestRunMi: 9,
  runsPerWeek: 4,
  suggestedDaysPerWeek: 4,
  dominantLongRunWeekday: 0,
  roadTrailMix: { road: 0.85, trail: 0.15 },
};

function keepFitProfile(today: string): SelectorProfile {
  return {
    experienceTier: 'experienced',
    goalDistance: 'keep_fit',
    daysPerWeek: 4,
    longRunDay: 0,
    goalState: 'day_to_day',
    targetDate: null,
    targetType: 'finish',
    targetTimeSec: null,
    race: null,
    injuries: [],
    today,
  };
}

/** Render a keep_fit plan as onboarding would (8-week rolling block). */
function renderKeepFit(today: string, snapshot: FitnessSnapshotInput | null = SNAP): Plan {
  const { template, params } = selectPlan(keepFitProfile(today), snapshot, DRAFT_SAFETY_CAPS);
  return renderPlan(template, params);
}

/** Render the continuation block the way extend.ts does. */
function renderContinuation(startDate: string, snapshot: FitnessSnapshotInput): Plan {
  const { template, params } = selectPlan(keepFitProfile(startDate), snapshot, DRAFT_SAFETY_CAPS);
  params.easeIn = false;
  return renderPlan(template, params);
}

describe('futureDatedDayCount / lastDatedDay', () => {
  it('counts only days strictly after today', () => {
    const plan = renderKeepFit('2026-06-08'); // a Monday
    const last = lastDatedDay(plan)!;
    expect(futureDatedDayCount(plan, last)).toBe(0);
    expect(futureDatedDayCount(plan, addDays(last, -14))).toBe(14);
    // The whole plan is in the future relative to the day before it starts.
    const first = plan.weeks[0]!.start_date!;
    expect(futureDatedDayCount(plan, addDays(first, -1))).toBe(plan.weeks.length * 7);
  });

  it('falls back to week start_date arithmetic for undated days', () => {
    const plan = renderKeepFit('2026-06-08');
    for (const w of plan.weeks) for (const d of w.days) delete d.date;
    expect(lastDatedDay(plan)).toBe(plan.weeks[plan.weeks.length - 1]!.end_date);
    expect(futureDatedDayCount(plan, '2020-01-01')).toBe(plan.weeks.length * 7);
  });

  it('returns null when no dates are derivable anywhere', () => {
    const plan = renderKeepFit('2026-06-08');
    for (const w of plan.weeks) {
      delete w.start_date;
      for (const d of w.days) delete d.date;
    }
    expect(futureDatedDayCount(plan, '2026-06-08')).toBeNull();
    expect(continuationStart(plan, '2026-06-08')).toBeNull();
  });
});

describe('continuationStart', () => {
  it('picks the first Monday after the last dated day, no ease-in, when the plan still has runway', () => {
    const plan = renderKeepFit('2026-06-08');
    const last = lastDatedDay(plan)!; // a Sunday
    const start = continuationStart(plan, addDays(last, -10))!;
    expect(start).toEqual({ startDate: addDays(last, 1), easeIn: false });
  });

  it('starts today with ease-in when the plan is already exhausted', () => {
    const plan = renderKeepFit('2026-06-08');
    const last = lastDatedDay(plan)!;
    const today = addDays(last, 17); // well past the wall, mid-week
    const start = continuationStart(plan, today)!;
    expect(start).toEqual({ startDate: today, easeIn: true });
  });

  it('plan ended yesterday (Sunday), today is Monday: full week starting today', () => {
    const plan = renderKeepFit('2026-06-08');
    const last = lastDatedDay(plan)!; // Sunday
    const start = continuationStart(plan, addDays(last, 1))!;
    expect(start).toEqual({ startDate: addDays(last, 1), easeIn: false });
  });
});

describe('renderPlan with easeIn: false', () => {
  it('week 1 is a normal full week (long run present, no rest-everything)', () => {
    const last = '2026-08-02'; // Sunday
    const cont = renderContinuation(addDays(last, 1), SNAP);
    const w1 = cont.weeks[0]!;
    expect(w1.start_date).toBe(addDays(last, 1));
    expect(w1.coaching_note?.startsWith('Ease-in week')).toBe(false);
    expect(w1.days.some((d) => d.type === 'long_run')).toBe(true);
  });

  it('default behavior unchanged: startDate inside week 1 still eases in', () => {
    const plan = renderKeepFit('2026-06-10'); // a Wednesday
    expect(plan.weeks[0]!.coaching_note?.startsWith('Ease-in week')).toBe(true);
  });
});

describe('mergeContinuation', () => {
  function buildMerged(): { existing: Plan; continuation: Plan; merged: Plan } {
    const existing = renderKeepFit('2026-06-08');
    const start = continuationStart(existing, '2026-07-20')!;
    const continuation = renderContinuation(start.startDate, {
      ...SNAP,
      recentWeeklyMileageMi: 30,
      longestRunMi: 11,
    });
    const merged = mergeContinuation(existing, continuation);
    return { existing, continuation, merged };
  }

  it('appends renumbered weeks, keeps old weeks byte-identical, passes the schema', () => {
    const { existing, continuation, merged } = buildMerged();
    expect(merged.weeks.length).toBe(existing.weeks.length + continuation.weeks.length);
    expect(merged.metadata.plan_structure.total_weeks).toBe(merged.weeks.length);
    // old weeks untouched (calendar UIDs depend on it)
    expect(merged.weeks.slice(0, existing.weeks.length)).toEqual(existing.weeks);
    // continuation weeks renumbered to follow on
    const offset = existing.weeks.length;
    continuation.weeks.forEach((w, i) => {
      expect(merged.weeks[offset + i]!.week_number).toBe(w.week_number + offset);
      expect(merged.weeks[offset + i]!.start_date).toBe(w.start_date);
    });
    expect(() => PlanSchema.parse(merged)).not.toThrow();
  });

  it('merged phases cover 1..total_weeks exactly once (schema refinement)', () => {
    const { merged } = buildMerged();
    expect(merged.metadata.plan_structure.phases?.length).toBeGreaterThan(0);
    // PlanSchema.parse inside mergeContinuation already enforces the cover —
    // assert directly anyway so a future refinement change doesn't mask it.
    const total = merged.metadata.plan_structure.total_weeks;
    const seen = new Set<number>();
    for (const p of merged.metadata.plan_structure.phases!) {
      for (const w of p.weeks) {
        expect(seen.has(w)).toBe(false);
        seen.add(w);
      }
    }
    expect(seen.size).toBe(total);
  });

  it('moves the placeholder race date to the new end and sets the flag', () => {
    const { merged } = buildMerged();
    expect(isPlaceholderRace(merged.metadata.race)).toBe(true);
    expect(merged.metadata.race.placeholder).toBe(true);
    expect(merged.metadata.race.date).toBe(merged.metadata.plan_structure.end_date);
    expect(merged.metadata.plan_structure.end_date).toBe(
      merged.weeks[merged.weeks.length - 1]!.end_date,
    );
  });

  it('keeps the existing plan top-level guidance and strength library', () => {
    const { existing, merged } = buildMerged();
    expect(merged.agent_guidance).toEqual(existing.agent_guidance);
    expect(merged.strength_workouts).toEqual(existing.strength_workouts);
  });

  it('the seam passes validateSafety (continuation starts from current fitness)', () => {
    const { merged } = buildMerged();
    const safety = validateSafety(merged, DRAFT_SAFETY_CAPS, 'keep_fit');
    if (!safety.ok) {
      console.error(safety.violations.map((v) => `w${v.week} ${v.rule}: ${v.detail}`));
    }
    expect(safety.ok).toBe(true);
  });

  it('drops phases when the existing plan has none (no partial cover)', () => {
    const { existing } = buildMerged();
    const noPhases = JSON.parse(JSON.stringify(existing)) as Plan;
    delete noPhases.metadata.plan_structure.phases;
    const start = continuationStart(noPhases, '2026-07-20')!;
    const continuation = renderContinuation(start.startDate, SNAP);
    const merged = mergeContinuation(noPhases, continuation);
    expect(merged.metadata.plan_structure.phases).toBeUndefined();
  });
});

describe('snapshotFromPlan', () => {
  it('derives weekly volume and longest run from the last non-cutback weeks', () => {
    const plan = renderKeepFit('2026-06-08');
    const snap = snapshotFromPlan(plan)!;
    const nonCutback = plan.weeks.filter((w) => w.phase !== 'cutback').slice(-4);
    const expected =
      nonCutback.reduce((s, w) => s + (w.planned_total_run_miles ?? 0), 0) / nonCutback.length;
    expect(snap.recentWeeklyMileageMi).toBeCloseTo(expected, 1);
    expect(snap.longestRunMi).toBeGreaterThan(0);
    expect(snap.runsPerWeek).toBeGreaterThanOrEqual(3);
    // SNAP's road/trail mix renders the plan as terrain 'mixed'; the derived
    // snapshot round-trips that so deriveTerrain lands on 'mixed' again.
    expect(snap.roadTrailMix).toEqual({ road: 1, trail: 1 });
  });

  it('a continuation seeded from it starts at trained-up volume, not the floor', () => {
    const plan = renderKeepFit('2026-06-08');
    const snap = snapshotFromPlan(plan)!;
    const start = continuationStart(plan, '2026-07-20')!;
    const cont = renderContinuation(start.startDate, snap);
    // base-maintenance floors at 12 mi/wk; the trained athlete's continuation
    // should start well above that.
    expect(cont.weeks[0]!.planned_total_run_miles!).toBeGreaterThan(15);
  });
});
