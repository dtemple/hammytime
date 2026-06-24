import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { buildCurrentBlock, type CurrentBlockView } from '../plan-current-block';
import { compactJson } from '../json-compact';
import { PlanSchema, type Day, type DayType, type Plan, type Week } from '@/lib/plan-schema';

// ---------------------------------------------------------------------------
// Fixture helpers — minimal, contiguous-week plans so today's position is exact.
// buildCurrentBlock takes a typed Plan but never validates, so we cast minimal
// objects; the seed integration test below covers a real, schema-valid plan.
// ---------------------------------------------------------------------------

const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function day(date: string, dayName: string, type: DayType = 'easy', miles = 5): Day {
  const base: Day = { day: dayName, date, type, description: `${type} session` };
  return type === 'rest' || type === 'race'
    ? type === 'race'
      ? { ...base, planned_distance_miles: miles, description: 'RACE DAY — tune-up' }
      : base
    : { ...base, planned_distance_miles: miles };
}

// A 7-day week starting Monday `startISO`. `raceDow` (0-6) makes that day a race.
function week(n: number, startISO: string, phase: string, raceDow?: number): Week {
  const days: Day[] = DOW.map((name, i) =>
    day(addDays(startISO, i), name, raceDow === i ? 'race' : 'easy', raceDow === i ? 13.1 : 5),
  );
  return {
    week_number: n,
    start_date: startISO,
    end_date: addDays(startISO, 6),
    phase: phase as Week['phase'],
    planned_total_run_miles: 30,
    days,
  } as Week;
}

type RaceOpt = { date?: string; placeholder?: boolean };

// `weeks` Mondays start at `firstMonday`, one phase per spec. Goal race defaults
// to a real race in the last week unless `race.placeholder` is set.
function makePlan(
  weekCount: number,
  firstMonday: string,
  opts: { phases?: string[]; raceDays?: Record<number, number>; race?: RaceOpt } = {},
): Plan {
  const weeks: Week[] = [];
  for (let i = 0; i < weekCount; i++) {
    const phase = opts.phases?.[i] ?? 'base';
    weeks.push(week(i + 1, addDays(firstMonday, i * 7), phase, opts.raceDays?.[i + 1]));
  }
  const lastEnd = addDays(firstMonday, weekCount * 7 - 1);
  const race = opts.race?.placeholder
    ? { name: 'Ongoing base — no race set', date: lastEnd, distance_miles: 26.2, placeholder: true }
    : { name: 'Goal Marathon', date: opts.race?.date ?? lastEnd, distance_miles: 26.2 };
  return {
    metadata: {
      race,
      plan_structure: { total_weeks: weekCount, start_date: firstMonday },
    },
    weeks,
  } as Plan;
}

function weekByNumber(view: CurrentBlockView, n: number) {
  return view.weeks.find((w) => w.week_number === n);
}
function isFull(w: CurrentBlockView['weeks'][number] | undefined): boolean {
  return !!w && !('skeleton' in w);
}
function isSkeleton(w: CurrentBlockView['weeks'][number] | undefined): boolean {
  return !!w && 'skeleton' in w && w.skeleton === true;
}

// ---------------------------------------------------------------------------

describe('buildCurrentBlock — window selection', () => {
  // 10-week plan, weeks 1..10 start Mondays from 2026-01-05. Placeholder race so
  // no goal-race lead-in muddies the window. today sits inside week 5.
  const plan = makePlan(10, '2026-01-05', { race: { placeholder: true } });
  const view = buildCurrentBlock(plan, '2026-02-04'); // week 5 = 02-02..02-08

  it('places today in the current week', () => {
    expect(view.current_week).toBe(5);
  });

  it('keeps the current week + next two at full day detail', () => {
    for (const n of [5, 6, 7]) {
      expect(isFull(weekByNumber(view, n))).toBe(true);
      expect((weekByNumber(view, n) as Week).days).toHaveLength(7);
    }
  });

  it('renders the weeks beyond the window as skeletons', () => {
    for (const n of [8, 9, 10]) expect(isSkeleton(weekByNumber(view, n))).toBe(true);
  });

  it('keeps the immediately-preceding week as a skeleton tail', () => {
    expect(isSkeleton(weekByNumber(view, 4))).toBe(true);
  });

  it('rolls the earlier weeks into one past summary and drops their objects', () => {
    expect(weekByNumber(view, 1)).toBeUndefined();
    expect(weekByNumber(view, 3)).toBeUndefined();
    expect(view.past_summary).toMatch(/Weeks 1–3/);
    expect(view.past_summary).toMatch(/3 weeks/);
  });

  it('keeps metadata, agent_guidance pass-through, and an empty races list for a placeholder race', () => {
    expect(view.metadata).toBe(plan.metadata);
    expect(view.races).toEqual([]);
  });
});

describe('buildCurrentBlock — boundaries', () => {
  it('clamps the window to week 1 when today is before the plan starts', () => {
    const plan = makePlan(8, '2026-01-05', { race: { placeholder: true } });
    const view = buildCurrentBlock(plan, '2025-12-01');
    expect(view.current_week).toBe(1);
    expect(isFull(weekByNumber(view, 1))).toBe(true);
    expect(view.past_summary).toBeUndefined();
  });

  it('leaves current_week null and all-but-last past when today is past the plan end', () => {
    const plan = makePlan(8, '2026-01-05', { race: { placeholder: true } });
    const view = buildCurrentBlock(plan, '2027-01-01');
    expect(view.current_week).toBeNull();
    expect(isSkeleton(weekByNumber(view, 8))).toBe(true); // last week is the tail
    expect(weekByNumber(view, 7)).toBeUndefined(); // everything before rolled up
    expect(view.past_summary).toMatch(/Weeks 1–7/);
  });

  it('emits no past summary when the current week is week 2', () => {
    const plan = makePlan(8, '2026-01-05', { race: { placeholder: true } });
    const view = buildCurrentBlock(plan, '2026-01-13'); // week 2 = 01-12..01-18
    expect(view.current_week).toBe(2);
    expect(isSkeleton(weekByNumber(view, 1))).toBe(true);
    expect(view.past_summary).toBeUndefined();
  });

  it('positions by day dates when week start/end are absent', () => {
    const plan = makePlan(6, '2026-01-05', { race: { placeholder: true } });
    // Strip the optional week-level bounds; days keep their dates.
    for (const w of plan.weeks) {
      delete (w as { start_date?: string }).start_date;
      delete (w as { end_date?: string }).end_date;
    }
    const view = buildCurrentBlock(plan, '2026-01-21'); // week 3 = 01-19..01-25
    expect(view.current_week).toBe(3);
    expect(isFull(weekByNumber(view, 3))).toBe(true);
  });
});

describe('buildCurrentBlock — races', () => {
  it('always surfaces a far tune-up and the goal race, in date order', () => {
    // Tune-up race on the Saturday of week 8 (far beyond the window and horizon).
    const plan = makePlan(12, '2026-01-05', { raceDays: { 8: 5 } });
    const view = buildCurrentBlock(plan, '2026-01-13'); // week 2 — week 8 is ~6+ weeks out
    const tuneup = view.races.find((r) => r.week_number === 8);
    expect(tuneup).toBeDefined();
    expect(tuneup!.is_goal_race).toBe(false);
    expect(view.races.some((r) => r.is_goal_race)).toBe(true);
    // The far tune-up's week is NOT pulled to full detail (beyond the horizon).
    expect(isSkeleton(weekByNumber(view, 8))).toBe(true);
    const dates = view.races.map((r) => r.date);
    expect([...dates]).toEqual([...dates].sort());
  });

  it('excludes a placeholder goal race entirely', () => {
    const plan = makePlan(8, '2026-01-05', { race: { placeholder: true } });
    const view = buildCurrentBlock(plan, '2026-01-13');
    expect(view.races).toEqual([]);
  });

  it('marks a race day that coincides with the goal-race date as the goal race', () => {
    // Goal race on the same Sunday as week 8's race day.
    const goalDate = addDays('2026-01-05', 7 * 7 + 6); // week 8 Sunday
    const plan = makePlan(8, '2026-01-05', { raceDays: { 8: 6 }, race: { date: goalDate } });
    const view = buildCurrentBlock(plan, '2026-01-13');
    const onDate = view.races.filter((r) => r.date === goalDate);
    expect(onDate).toHaveLength(1); // not duplicated
    expect(onDate[0]!.is_goal_race).toBe(true);
  });
});

describe('buildCurrentBlock — near-horizon lead-in', () => {
  it('pulls a near race week and its two lead-in weeks to full detail', () => {
    // Race in week 5 (~4 weeks out from a week-1 today → inside 42 days).
    const plan = makePlan(10, '2026-01-05', { raceDays: { 5: 5 } });
    const view = buildCurrentBlock(plan, '2026-01-07'); // week 1
    // Window covers weeks 1-3; the race lead-in pulls weeks 3,4,5 to full.
    for (const n of [3, 4, 5]) expect(isFull(weekByNumber(view, n))).toBe(true);
  });

  it('leaves a race beyond the horizon as a skeleton week', () => {
    const plan = makePlan(14, '2026-01-05', { raceDays: { 12: 5 } });
    const view = buildCurrentBlock(plan, '2026-01-07'); // week 12 ~ 11 weeks out
    expect(isSkeleton(weekByNumber(view, 12))).toBe(true);
  });
});

describe('buildCurrentBlock — serialization', () => {
  const plan = makePlan(10, '2026-01-05', { race: { placeholder: true } });
  const view = buildCurrentBlock(plan, '2026-02-04');
  const text = compactJson(view);

  it('round-trips through compactJson', () => {
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(view)));
  });

  it('collapses a skeleton week onto a single line', () => {
    // compactJson emits a collapsed object via JSON.stringify (no spaces).
    const skeletonLine = text.split('\n').find((l) => l.includes('"skeleton":true'));
    expect(skeletonLine).toBeDefined();
    expect(skeletonLine).toMatch(/"week_number":\d+/); // whole object on the one line
  });

  it('keeps a full week multi-line with one day per line', () => {
    expect(text).toMatch(/"days": \[\n/); // the current week's days expanded
  });
});

describe('buildCurrentBlock — real seed plan', () => {
  const seed = JSON.parse(
    readFileSync(path.join(__dirname, '../../seeds/marathon_training_plan.json'), 'utf8'),
  );
  const plan = PlanSchema.parse(seed); // the seed is schema-valid

  it('builds a view that keeps metadata, agent_guidance, and strength whole', () => {
    const view = buildCurrentBlock(plan, '2026-06-01');
    expect(view.metadata).toBe(plan.metadata);
    expect(view.agent_guidance).toBe(plan.agent_guidance);
    expect(view.strength_workouts).toBe(plan.strength_workouts);
    // The seed's only race day is the goal race in the final week — surfaced once.
    expect(view.races).toHaveLength(1);
    expect(view.races[0]!.is_goal_race).toBe(true);
  });
});
