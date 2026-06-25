import { describe, it, expect } from 'vitest';
import type { Plan } from './plan-schema';
import {
  bucketRealizedSeries,
  computeDrift,
  computeReadiness,
  renderDriftSummary,
  renderReadiness,
  type RealizedWeek,
} from './plan-drift';

// computeDrift only reads weeks[].{week_number,phase,days[]}; it never runs
// PlanSchema, so minimal fixtures cast to Plan keep these tests focused.
type DayLite = { day: string; date: string; type: string; planned_distance_miles?: number };
function week(week_number: number, phase: string, days: DayLite[]) {
  return { week_number, phase, days };
}
function asPlan(weeks: ReturnType<typeof week>[]): Plan {
  return { weeks } as unknown as Plan;
}

const baseline = asPlan([
  week(1, 'build', [
    { day: 'Monday', date: '2026-03-30', type: 'long_run', planned_distance_miles: 18 },
    { day: 'Wednesday', date: '2026-04-01', type: 'easy', planned_distance_miles: 6 },
    { day: 'Saturday', date: '2026-04-04', type: 'rest' },
  ]),
]);

describe('computeDrift', () => {
  it('reports no edits when the working plan equals the baseline', () => {
    const drift = computeDrift(baseline, baseline);
    expect(drift.hasEdits).toBe(false);
    expect(drift.weeks).toHaveLength(0);
    expect(drift.changedDayCount).toBe(0);
    expect(renderDriftSummary(drift)).toContain('no drift');
  });

  it('captures a moved long run as two changed days with zero net volume', () => {
    // Long run swaps from Monday to Wednesday; weekly mileage is unchanged.
    const moved = asPlan([
      week(1, 'build', [
        { day: 'Monday', date: '2026-03-30', type: 'easy', planned_distance_miles: 6 },
        { day: 'Wednesday', date: '2026-04-01', type: 'long_run', planned_distance_miles: 18 },
        { day: 'Saturday', date: '2026-04-04', type: 'rest' },
      ]),
    ]);

    const drift = computeDrift(baseline, moved);
    expect(drift.hasEdits).toBe(true);
    expect(drift.changedWeekCount).toBe(1);
    expect(drift.changedDayCount).toBe(2);
    expect(drift.weeks[0]!.deltaMiles).toBe(0);

    const monday = drift.weeks[0]!.changedDays.find((d) => d.day === 'Monday')!;
    expect(monday.from).toEqual({ type: 'long_run', miles: 18 });
    expect(monday.to).toEqual({ type: 'easy', miles: 6 });

    const summary = renderDriftSummary(drift);
    expect(summary).toContain('Week 1 (build)');
    expect(summary).toContain('Monday 2026-03-30');
    expect(summary).toContain('Days changed: 2');
  });

  it('computes a cumulative volume delta and percentage', () => {
    const lighter = asPlan([
      week(1, 'build', [
        { day: 'Monday', date: '2026-03-30', type: 'long_run', planned_distance_miles: 18 },
        { day: 'Wednesday', date: '2026-04-01', type: 'easy', planned_distance_miles: 3 },
        { day: 'Saturday', date: '2026-04-04', type: 'rest' },
      ]),
    ]);

    const drift = computeDrift(baseline, lighter);
    expect(drift.cumulative.baselineMiles).toBe(24);
    expect(drift.cumulative.workingMiles).toBe(21);
    expect(drift.cumulative.deltaMiles).toBe(-3);
    expect(drift.cumulative.deltaPct).toBe(-12);
    expect(drift.changedDayCount).toBe(1);
    expect(renderDriftSummary(drift)).toContain('21 mi working vs 24 mi original');
  });
});

// ---------------------------------------------------------------------------
// Race readiness — the macro long-run-spine signal.
// ---------------------------------------------------------------------------

type LrDay = { day: string; date: string; type: string; planned_distance_miles?: number };

// A week with one long_run day (dated to its end) and one easy day (dated to its
// start) for volume; race weeks pass longMi 0. start/end set both the week bounds
// and the day dates readiness reads.
function lrWeek(
  week_number: number,
  phase: string,
  start: string,
  end: string,
  longMi: number,
  easyMi = 5,
) {
  const days: LrDay[] = [{ day: 'Tuesday', date: start, type: 'easy', planned_distance_miles: easyMi }];
  if (longMi > 0)
    days.push({ day: 'Saturday', date: end, type: 'long_run', planned_distance_miles: longMi });
  return { week_number, phase, start_date: start, end_date: end, days };
}

const GOAL_RACE = { name: 'CIM', date: '2026-11-15', distance_miles: 26.2 };

function racePlan(weeks: ReturnType<typeof lrWeek>[], race = GOAL_RACE): Plan {
  return { weeks, metadata: { race } } as unknown as Plan;
}

// Baseline marathon block: long runs climb 14→16→18→20 (peak, week 4), then a
// 12 mi taper and a race week. Race day 2026-11-15.
const RACE_BASELINE = racePlan([
  lrWeek(1, 'build', '2026-10-05', '2026-10-11', 14),
  lrWeek(2, 'build', '2026-10-12', '2026-10-18', 16),
  lrWeek(3, 'build', '2026-10-19', '2026-10-25', 18),
  lrWeek(4, 'peak', '2026-10-26', '2026-11-01', 20),
  lrWeek(5, 'taper', '2026-11-02', '2026-11-08', 12),
  lrWeek(6, 'race', '2026-11-09', '2026-11-15', 0),
]);

describe('computeReadiness', () => {
  it('ON TRACK when the working plan still carries the original peak ahead', () => {
    const r = computeReadiness(RACE_BASELINE, RACE_BASELINE, '2026-10-08')!;
    expect(r).not.toBeNull();
    expect(r.verdict).toBe('on_track');
    expect(r.baselinePeakMi).toBe(20);
    expect(r.longestAheadMi).toBe(20);
    expect(r.weeksToRace).toBe(6);
    expect(r.longRunsLost).toBe(0);
    expect(r.reason).toContain('spine intact');
  });

  it('WATCH when the spine is intact but total volume has bled off >10%', () => {
    // Every long run kept; easy days slashed 5 → 1, so cumulative running drops
    // well past the watch threshold without touching the peak.
    const lean = racePlan([
      lrWeek(1, 'build', '2026-10-05', '2026-10-11', 14, 1),
      lrWeek(2, 'build', '2026-10-12', '2026-10-18', 16, 1),
      lrWeek(3, 'build', '2026-10-19', '2026-10-25', 18, 1),
      lrWeek(4, 'peak', '2026-10-26', '2026-11-01', 20, 1),
      lrWeek(5, 'taper', '2026-11-02', '2026-11-08', 12, 1),
      lrWeek(6, 'race', '2026-11-09', '2026-11-15', 0, 1),
    ]);
    const r = computeReadiness(RACE_BASELINE, lean, '2026-10-08')!;
    expect(r.verdict).toBe('watch');
    expect(r.longestAheadMi).toBe(20); // peak still scheduled
    expect(r.cumulativeDeltaPct!).toBeLessThanOrEqual(-10);
    expect(r.reason).toContain('spine intact');
  });

  it('WATCH when the peak has slipped but the runway can still rebuild it', () => {
    // Weeks 3 and 4 cut to 17; by 2026-10-19 the athlete has banked the 16 mi
    // (week 2), and 2 build weeks remain before the taper — enough to climb back.
    const slipped = racePlan([
      lrWeek(1, 'build', '2026-10-05', '2026-10-11', 14),
      lrWeek(2, 'build', '2026-10-12', '2026-10-18', 16),
      lrWeek(3, 'build', '2026-10-19', '2026-10-25', 17),
      lrWeek(4, 'peak', '2026-10-26', '2026-11-01', 17),
      lrWeek(5, 'taper', '2026-11-02', '2026-11-08', 12),
      lrWeek(6, 'race', '2026-11-09', '2026-11-15', 0),
    ]);
    const r = computeReadiness(RACE_BASELINE, slipped, '2026-10-19')!;
    expect(r.verdict).toBe('watch');
    expect(r.currentRungMi).toBe(16);
    expect(r.longestAheadMi).toBe(17);
    expect(r.buildWeeksLeft).toBe(2);
    expect(r.reason).toContain('rebuild');
  });

  it('AT RISK when the peak is gone and the runway can no longer rebuild it', () => {
    // The long run keeps getting cut: weeks 3 and 4 down to 12. Early in the
    // block (nothing banked yet), 3 build weeks at +2/wk can't reach ~20.
    const eroded = racePlan([
      lrWeek(1, 'build', '2026-10-05', '2026-10-11', 14),
      lrWeek(2, 'build', '2026-10-12', '2026-10-18', 16),
      lrWeek(3, 'build', '2026-10-19', '2026-10-25', 12),
      lrWeek(4, 'peak', '2026-10-26', '2026-11-01', 12),
      lrWeek(5, 'taper', '2026-11-02', '2026-11-08', 12),
      lrWeek(6, 'race', '2026-11-09', '2026-11-15', 0),
    ]);
    const r = computeReadiness(RACE_BASELINE, eroded, '2026-10-08')!;
    expect(r.verdict).toBe('at_risk');
    expect(r.longestAheadMi).toBe(16);
    expect(r.longRunsLost).toBe(2); // weeks 3 and 4 each cut >= 3 mi
    expect(r.reason).toContain('may no longer be realistic');
  });

  it('fires for an adventure the same as a race, with event-neutral copy', () => {
    // An adventure (W4b) commits a real, non-placeholder dated event into
    // metadata.race, so it flows through identically — and the rendered copy must
    // not call it a "race".
    const adventure = { name: 'Rae Lakes Loop', date: '2026-11-15', distance_miles: 33 };
    const base = racePlan(RACE_BASELINE.weeks as never, adventure as never);
    const r = computeReadiness(base, base, '2026-10-08')!;
    expect(r).not.toBeNull();
    expect(r.verdict).toBe('on_track');
    const out = renderReadiness(r);
    expect(out).toContain('Rae Lakes Loop');
    expect(out).not.toMatch(/race day|goal race|conservative race/i);
  });

  it('returns null for a placeholder race, a past race, or a spine-less plan', () => {
    const placeholder = racePlan(RACE_BASELINE.weeks as never, {
      ...GOAL_RACE,
      placeholder: true,
    } as never);
    expect(computeReadiness(placeholder, placeholder, '2026-10-08')).toBeNull();

    // Race already behind today.
    expect(computeReadiness(RACE_BASELINE, RACE_BASELINE, '2026-11-20')).toBeNull();

    // No long_run days anywhere → no spine to assess.
    const spineless = racePlan([
      { week_number: 1, phase: 'build', start_date: '2026-10-05', end_date: '2026-10-11', days: [
        { day: 'Tuesday', date: '2026-10-05', type: 'easy', planned_distance_miles: 5 },
      ] } as never,
    ]);
    expect(computeReadiness(spineless, spineless, '2026-10-08')).toBeNull();
  });
});

describe('renderReadiness', () => {
  it('renders the verdict, the spine line, and (at risk) the fork', () => {
    const eroded = racePlan([
      lrWeek(1, 'build', '2026-10-05', '2026-10-11', 14),
      lrWeek(2, 'build', '2026-10-12', '2026-10-18', 16),
      lrWeek(3, 'build', '2026-10-19', '2026-10-25', 12),
      lrWeek(4, 'peak', '2026-10-26', '2026-11-01', 12),
      lrWeek(5, 'taper', '2026-11-02', '2026-11-08', 12),
      lrWeek(6, 'race', '2026-11-09', '2026-11-15', 0),
    ]);
    const out = renderReadiness(computeReadiness(RACE_BASELINE, eroded, '2026-10-08')!);
    expect(out).toContain('# Race readiness');
    expect(out).toContain('Verdict: AT RISK');
    expect(out).toContain('original peak 20 mi');
    expect(out).toContain('move it to a later date'); // the fork (event-neutral)
  });

  it('omits the fork when not at risk', () => {
    const out = renderReadiness(computeReadiness(RACE_BASELINE, RACE_BASELINE, '2026-10-08')!);
    expect(out).toContain('Verdict: ON TRACK');
    expect(out).not.toContain('move it to a later date');
  });
});

// ---------------------------------------------------------------------------
// Readiness v2 — Strava-aware (the realized series). Specs/READINESS_V2.md.
// ---------------------------------------------------------------------------

// A longer build for the divergence/coverage cases: long runs climb 12→…→20
// (peak week 7), then a 12 mi taper and a race week. Race day 2026-11-08.
const V2_RACE = { name: 'CIM', date: '2026-11-08', distance_miles: 26.2 };
const V2_BASELINE = racePlan(
  [
    lrWeek(1, 'build', '2026-09-07', '2026-09-13', 12),
    lrWeek(2, 'build', '2026-09-14', '2026-09-20', 14),
    lrWeek(3, 'build', '2026-09-21', '2026-09-27', 15),
    lrWeek(4, 'build', '2026-09-28', '2026-10-04', 16),
    lrWeek(5, 'build', '2026-10-05', '2026-10-11', 17),
    lrWeek(6, 'build', '2026-10-12', '2026-10-18', 18),
    lrWeek(7, 'peak', '2026-10-19', '2026-10-25', 20),
    lrWeek(8, 'taper', '2026-10-26', '2026-11-01', 12),
    lrWeek(9, 'race', '2026-11-02', '2026-11-08', 0),
  ],
  V2_RACE,
);

describe('computeReadiness — realized (v2)', () => {
  it('AT RISK on silent skips even when the calendar still shows the peak (v1 says ON TRACK)', () => {
    // Plan unedited (peak 20 still scheduled ahead), but the athlete has only run
    // 8–9 mi long runs. v1 trusts the calendar; v2 reads the realized rung.
    const realized: RealizedWeek[] = [
      { week_number: 1, actualLongRunMi: 8, actualVolumeMi: 20 },
      { week_number: 2, actualLongRunMi: 9, actualVolumeMi: 22 },
      { week_number: 3, actualLongRunMi: 8, actualVolumeMi: 20 },
    ];
    const v1 = computeReadiness(RACE_BASELINE, RACE_BASELINE, '2026-10-20')!;
    expect(v1.verdict).toBe('on_track'); // the blind spot v1 leaves open

    const v2 = computeReadiness(RACE_BASELINE, RACE_BASELINE, '2026-10-20', realized)!;
    expect(v2.verdict).toBe('at_risk');
    expect(v2.realizedDataAvailable).toBe(true);
    expect(v2.realizedRungMi).toBe(9); // trailing-window max of the actuals
    expect(v2.reason).toContain('9 mi');
    expect(v2.reason).toMatch(/actually been run/i);
  });

  it('WATCH + reconcile when the plan shows long runs Strava has no match for', () => {
    // Spine intact and a recent 18 mi keeps the rung reachable, but weeks 3 and 5
    // long runs were never run — two misses past the 1-week slack → divergence.
    const realized: RealizedWeek[] = [
      { week_number: 1, actualLongRunMi: 12, actualVolumeMi: 30 },
      { week_number: 2, actualLongRunMi: 14, actualVolumeMi: 32 },
      { week_number: 3, actualLongRunMi: 8, actualVolumeMi: 20 }, // missed (planned 15)
      { week_number: 4, actualLongRunMi: 16, actualVolumeMi: 34 },
      { week_number: 5, actualLongRunMi: 9, actualVolumeMi: 22 }, // missed (planned 17)
      { week_number: 6, actualLongRunMi: 18, actualVolumeMi: 36 },
    ];
    const r = computeReadiness(V2_BASELINE, V2_BASELINE, '2026-10-15', realized)!;
    expect(r.verdict).toBe('watch');
    expect(r.planDiverged).toBe(true);
    expect(r.divergedWeeks).toEqual([3, 5]);
    expect(r.realizedRungMi).toBe(18);
    const out = renderReadiness(r);
    expect(out).toContain('Reconcile:');
    expect(out).toContain('weeks 3, 5');
  });

  it('one missed long run stays within the slack — no divergence', () => {
    const realized: RealizedWeek[] = [
      { week_number: 1, actualLongRunMi: 12, actualVolumeMi: 30 },
      { week_number: 2, actualLongRunMi: 14, actualVolumeMi: 32 },
      { week_number: 3, actualLongRunMi: 8, actualVolumeMi: 20 }, // the one miss
      { week_number: 4, actualLongRunMi: 16, actualVolumeMi: 34 },
      { week_number: 5, actualLongRunMi: 17, actualVolumeMi: 38 },
      { week_number: 6, actualLongRunMi: 18, actualVolumeMi: 36 },
    ];
    const r = computeReadiness(V2_BASELINE, V2_BASELINE, '2026-10-15', realized)!;
    expect(r.missedLongRuns).toBe(1);
    expect(r.planDiverged).toBe(false);
    expect(r.verdict).toBe('on_track');
  });

  it('hybrid "done" tolerance — 85% pct bar and the −2 mi absolute bar both count', () => {
    // w2 planned 20 / ran 17 (=85%) → done. w3 planned 10 / ran 8 (=planned−2) →
    // done. w4 planned 20 / ran 16 (under both bars) → the only miss.
    const HYBRID = racePlan(
      [
        lrWeek(1, 'build', '2026-09-07', '2026-09-13', 12),
        lrWeek(2, 'build', '2026-09-14', '2026-09-20', 20),
        lrWeek(3, 'build', '2026-09-21', '2026-09-27', 10),
        lrWeek(4, 'build', '2026-09-28', '2026-10-04', 20),
        lrWeek(5, 'peak', '2026-10-05', '2026-10-11', 20),
        lrWeek(6, 'taper', '2026-10-12', '2026-10-18', 12),
        lrWeek(7, 'race', '2026-10-19', '2026-10-25', 0),
      ],
      { name: 'CIM', date: '2026-10-25', distance_miles: 26.2 },
    );
    const realized: RealizedWeek[] = [
      { week_number: 1, actualLongRunMi: 12, actualVolumeMi: 30 },
      { week_number: 2, actualLongRunMi: 17, actualVolumeMi: 34 }, // 85% bar
      { week_number: 3, actualLongRunMi: 8, actualVolumeMi: 22 }, // −2 mi bar
      { week_number: 4, actualLongRunMi: 16, actualVolumeMi: 34 }, // miss
    ];
    const r = computeReadiness(HYBRID, HYBRID, '2026-10-08', realized)!;
    expect(r.missedLongRuns).toBe(1);
    expect(r.divergedWeeks).toEqual([4]);
  });

  it('coverage gap — weeks before the first observed run are not counted as missed', () => {
    // No Strava data for weeks 1–2 (athlete connected mid-build); they must not
    // read as skipped long runs even though the plan had long runs there.
    const realized: RealizedWeek[] = [
      { week_number: 1, actualLongRunMi: 0, actualVolumeMi: 0 },
      { week_number: 2, actualLongRunMi: 0, actualVolumeMi: 0 },
      { week_number: 3, actualLongRunMi: 15, actualVolumeMi: 30 },
      { week_number: 4, actualLongRunMi: 16, actualVolumeMi: 32 },
      { week_number: 5, actualLongRunMi: 17, actualVolumeMi: 34 },
      { week_number: 6, actualLongRunMi: 18, actualVolumeMi: 36 },
    ];
    const r = computeReadiness(V2_BASELINE, V2_BASELINE, '2026-10-15', realized)!;
    expect(r.missedLongRuns).toBe(0);
    expect(r.planDiverged).toBe(false);
    expect(r.realizedRungMi).toBe(18);
  });

  it('degrades to v1 (plan-only) when no realized series, and render flags it', () => {
    const eroded = racePlan([
      lrWeek(1, 'build', '2026-10-05', '2026-10-11', 14),
      lrWeek(2, 'build', '2026-10-12', '2026-10-18', 16),
      lrWeek(3, 'build', '2026-10-19', '2026-10-25', 12),
      lrWeek(4, 'peak', '2026-10-26', '2026-11-01', 12),
      lrWeek(5, 'taper', '2026-11-02', '2026-11-08', 12),
      lrWeek(6, 'race', '2026-11-09', '2026-11-15', 0),
    ]);
    const r = computeReadiness(RACE_BASELINE, eroded, '2026-10-08', null)!;
    expect(r.realizedDataAvailable).toBe(false);
    expect(r.realizedRungMi).toBeNull();
    expect(r.verdict).toBe('at_risk'); // same as the v1 plan-only verdict
    expect(renderReadiness(r)).toContain('Reading the plan only');
  });
});

describe('bucketRealizedSeries', () => {
  const act = (type: string, date: string, mi: number) => ({
    type,
    start_date_local: `${date}T08:00:00`,
    distance_m: mi * 1609.344,
  });

  it('buckets runs by date, takes week-max + sum, filters non-runs, drops out-of-window', () => {
    const plan = racePlan([
      lrWeek(1, 'build', '2026-10-05', '2026-10-11', 16),
      lrWeek(2, 'build', '2026-10-12', '2026-10-18', 18),
      lrWeek(3, 'build', '2026-10-26', '2026-11-01', 20), // not started at today
    ]);
    const activities = [
      act('Run', '2026-10-07', 10),
      act('TrailRun', '2026-10-10', 14), // bigger run in week 1
      act('Ride', '2026-10-08', 31), // not a run — excluded
      act('Run', '2026-10-14', 12), // week 2
      act('Run', '2026-09-01', 8), // before the plan — dropped
    ];
    const series = bucketRealizedSeries(plan, activities, '2026-10-20');
    expect(series).toEqual([
      { week_number: 1, actualLongRunMi: 14, actualVolumeMi: 24 },
      { week_number: 2, actualLongRunMi: 12, actualVolumeMi: 12 },
    ]);
  });

  it('returns null when no week carries usable date bounds', () => {
    const noDates = racePlan([
      { week_number: 1, phase: 'build', days: [{ day: 'Monday', type: 'easy' }] } as never,
    ]);
    expect(bucketRealizedSeries(noDates, [], '2026-10-20')).toBeNull();
  });
});
