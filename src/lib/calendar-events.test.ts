import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { planToCalendarEvents } from './calendar-events';
import { PlanSchema, type Plan } from './plan-schema';

const seedPath = join(__dirname, '../../seeds/marathon_training_plan.json');
const rawSeed = JSON.parse(readFileSync(seedPath, 'utf-8'));
const seedPlan = PlanSchema.parse(rawSeed);

const baseInput = {
  plan: seedPlan,
  planId: 'plan-uuid',
  planStartDate: '2026-03-30',
};

describe('planToCalendarEvents', () => {
  it('returns [] when plan or planId is missing', () => {
    expect(planToCalendarEvents({ plan: null, planId: null, planStartDate: null })).toEqual([]);
    expect(
      planToCalendarEvents({ plan: seedPlan, planId: null, planStartDate: '2026-03-30' }),
    ).toEqual([]);
  });

  it('emits one event per plan day', () => {
    const events = planToCalendarEvents(baseInput);
    const expected = seedPlan.weeks.reduce((n, w) => n + w.days.length, 0);
    expect(events.length).toBe(expected);
  });

  it('keys UIDs on planId, week number, and day index', () => {
    const events = planToCalendarEvents(baseInput);
    expect(events[0]!.uid).toBe('plan-uuid-w1-d0@hammytime');
    const uids = new Set(events.map((e) => e.uid));
    expect(uids.size).toBe(events.length);
  });

  it('computes dates from planStartDate + week/day offset', () => {
    const events = planToCalendarEvents(baseInput);
    // Week 1 day 0 lands on the start date; week 2 day 3 is start + 10 days.
    expect(events[0]!.date).toBe('2026-03-30');
    const w2d3 = events.find((e) => e.uid === 'plan-uuid-w2-d3@hammytime');
    expect(w2d3!.date).toBe('2026-04-09');
  });

  it('prefers an explicit day.date over the computed offset', () => {
    const plan: Plan = JSON.parse(JSON.stringify(seedPlan));
    plan.weeks[0]!.days[0]!.date = '2026-05-01';
    const events = planToCalendarEvents({ ...baseInput, plan });
    expect(events[0]!.date).toBe('2026-05-01');
  });

  it('skips days with no derivable date', () => {
    const events = planToCalendarEvents({ ...baseInput, planStartDate: null });
    // Seed plan days carry no explicit dates, so nothing can be placed.
    const explicitDates = seedPlan.weeks.flatMap((w) => w.days).filter((d) => d.date).length;
    expect(events.length).toBe(explicitDates);
  });

  it('builds summary with emoji, label, and distance suffix', () => {
    const events = planToCalendarEvents(baseInput);
    expect(events[0]!.summary).toBe('🏃 Long Run 7mi');
  });

  it('expands strength days from strength_workouts with corpus links', () => {
    const events = planToCalendarEvents(baseInput);
    const upper = events.find((e) => e.uid === 'plan-uuid-w1-d2@hammytime');
    expect(upper!.summary).toContain('Upper Body');
    expect(upper!.description).toContain('## Exercises');
    expect(upper!.description).toContain('Push-ups or Bench Press');
    // Dead Bug resolves by name-fallback to the corpus → source URL on the line.
    expect(upper!.description).toContain('https://www.youtube.com/watch?v=BZYaCzbP09M');
    // Bird Dog has no corpus entry → no link.
    const birdDog = upper!.description.split('\n').find((l) => l.includes('Bird Dog'));
    expect(birdDog).toBeDefined();
    expect(birdDog).not.toMatch(/https?:\/\//);
  });

  it("sets location 'trail' only when day.prefer_trail", () => {
    const plan: Plan = JSON.parse(JSON.stringify(seedPlan));
    plan.weeks[0]!.days[0]!.prefer_trail = true;
    const events = planToCalendarEvents({ ...baseInput, plan });
    expect(events[0]!.location).toBe('trail');
    expect(events[1]!.location).toBeUndefined();
  });
});
