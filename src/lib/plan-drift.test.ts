import { describe, it, expect } from 'vitest';
import type { Plan } from './plan-schema';
import {
  computeDrift,
  computeReadiness,
  renderDriftSummary,
  renderReadiness,
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
    expect(out).toContain('move the race to a later date'); // the fork
  });

  it('omits the fork when not at risk', () => {
    const out = renderReadiness(computeReadiness(RACE_BASELINE, RACE_BASELINE, '2026-10-08')!);
    expect(out).toContain('Verdict: ON TRACK');
    expect(out).not.toContain('move the race to a later date');
  });
});
