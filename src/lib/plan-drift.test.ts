import { describe, it, expect } from 'vitest';
import type { Plan } from './plan-schema';
import { computeDrift, renderDriftSummary } from './plan-drift';

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
