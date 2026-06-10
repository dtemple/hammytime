import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import ical from 'node-ical';
import { renderPlanIcs } from './calendar-render';
import { PlanSchema } from './plan-schema';

const seedPath = join(__dirname, '../../seeds/marathon_training_plan.json');
const rawSeed = JSON.parse(readFileSync(seedPath, 'utf-8'));
const seedPlan = PlanSchema.parse(rawSeed);

describe('renderPlanIcs', () => {
  it('returns a valid empty calendar when no plan is provided', () => {
    const ics = renderPlanIcs({
      athleteName: 'Test',
      timezone: 'America/Los_Angeles',
      plan: null,
      planId: null,
      planStartDate: null,
    });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('no active training plan');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('renders one VEVENT per day for the canonical seed plan', () => {
    const ics = renderPlanIcs({
      athleteName: 'David',
      timezone: 'America/Los_Angeles',
      plan: seedPlan,
      planId: 'plan-version-uuid',
      planStartDate: '2026-03-30',
    });
    const expectedEventCount = seedPlan.weeks.reduce((n, w) => n + w.days.length, 0);
    const matches = ics.match(/BEGIN:VEVENT/g) ?? [];
    expect(matches.length).toBe(expectedEventCount);
  });

  it('places week 1 Monday long_run on 2026-03-30', () => {
    const ics = renderPlanIcs({
      athleteName: 'David',
      timezone: 'America/Los_Angeles',
      plan: seedPlan,
      planId: 'plan-version-uuid',
      planStartDate: '2026-03-30',
    });

    // Find the VEVENT block for the week-1-day-0 UID, then assert on its DTSTART line.
    const eventBlock = ics
      .split('BEGIN:VEVENT')
      .find((chunk) => chunk.includes('UID:plan-version-uuid-w1-d0@hammytime'));
    expect(eventBlock).toBeDefined();
    expect(eventBlock!).toMatch(/DTSTART;VALUE=DATE:20260330/);
    expect(eventBlock!).toContain('SUMMARY:');
    expect(eventBlock!).toContain('Long Run');
    expect(eventBlock!).toContain('7mi');
  });

  it('produces unique UIDs across all events and is stable across two renders', () => {
    const ics1 = renderPlanIcs({
      athleteName: 'David',
      timezone: 'America/Los_Angeles',
      plan: seedPlan,
      planId: 'plan-version-uuid',
      planStartDate: '2026-03-30',
    });
    const ics2 = renderPlanIcs({
      athleteName: 'David',
      timezone: 'America/Los_Angeles',
      plan: seedPlan,
      planId: 'plan-version-uuid',
      planStartDate: '2026-03-30',
    });

    const uids = [...ics1.matchAll(/UID:(.+)/g)].map((m) => (m[1] ?? '').trim());
    const uniq = new Set(uids);
    expect(uniq.size).toBe(uids.length);

    const uids2 = [...ics2.matchAll(/UID:(.+)/g)].map((m) => (m[1] ?? '').trim());
    expect(uids2).toEqual(uids);
  });

  it('expands strength days with the referenced strength_workouts entry', () => {
    const ics = renderPlanIcs({
      athleteName: 'David',
      timezone: 'America/Los_Angeles',
      plan: seedPlan,
      planId: 'pv',
      planStartDate: '2026-03-30',
    });
    const parsed = ical.sync.parseICS(ics);
    const upper = Object.values(parsed).find(
      (e) => (e as { uid?: string }).uid === 'pv-w1-d2@hammytime',
    ) as { description?: string; summary?: string } | undefined;
    expect(upper).toBeDefined();
    expect(upper!.summary).toContain('Upper Body');
    expect(upper!.description).toContain('## Exercises');
    expect(upper!.description).toContain('Push-ups or Bench Press');
  });

  it('links a strength exercise to its corpus source URL', () => {
    const ics = renderPlanIcs({
      athleteName: 'David',
      timezone: 'America/Los_Angeles',
      plan: seedPlan,
      planId: 'pv',
      planStartDate: '2026-03-30',
    });
    const parsed = ical.sync.parseICS(ics);
    const upper = Object.values(parsed).find(
      (e) => (e as { uid?: string }).uid === 'pv-w1-d2@hammytime',
    ) as { description?: string } | undefined;
    // The seed's upper-body day has "Dead Bug" — resolved by name-fallback to
    // the `dead-bug` corpus entry, so its source URL rides the exercise line.
    const desc = upper!.description ?? '';
    expect(desc).toContain('https://www.youtube.com/watch?v=BZYaCzbP09M');
    // Bird Dog has no corpus entry → no link (no fabricated URL).
    const birdDog = desc.split('\n').find((l) => l.includes('Bird Dog'));
    expect(birdDog).toBeDefined();
    expect(birdDog).not.toMatch(/https?:\/\//);
  });

  it('shows the real race in the calendar description', () => {
    const ics = renderPlanIcs({
      athleteName: 'David',
      timezone: 'America/Los_Angeles',
      plan: seedPlan,
      planId: 'pv',
      planStartDate: '2026-03-30',
    });
    expect(ics).toContain(seedPlan.metadata.race.name);
  });

  it('suppresses the synthetic placeholder race from the description (keep_fit / intended)', () => {
    for (const name of ['Ongoing base — no race set', 'Goal 5k — date TBD']) {
      const plan = PlanSchema.parse({
        ...rawSeed,
        metadata: { ...rawSeed.metadata, race: { ...rawSeed.metadata.race, name } },
      });
      const ics = renderPlanIcs({
        athleteName: 'Sam',
        timezone: 'America/Los_Angeles',
        plan,
        planId: 'pv',
        planStartDate: '2026-03-30',
      });
      expect(ics).toContain('Rolling training plan — no race set');
      expect(ics).not.toContain(name.split(' — ')[0]); // neither name nor its fake date line
    }
    // The flag alone also suppresses, independent of the name.
    const flagged = PlanSchema.parse({
      ...rawSeed,
      metadata: {
        ...rawSeed.metadata,
        race: { ...rawSeed.metadata.race, placeholder: true },
      },
    });
    const ics = renderPlanIcs({
      athleteName: 'Sam',
      timezone: 'America/Los_Angeles',
      plan: flagged,
      planId: 'pv',
      planStartDate: '2026-03-30',
    });
    expect(ics).toContain('Rolling training plan — no race set');
  });

  it('snapshot of the rendered calendar', () => {
    const ics = renderPlanIcs({
      athleteName: 'David',
      timezone: 'America/Los_Angeles',
      plan: seedPlan,
      planId: 'fixed-uuid-for-snapshot',
      planStartDate: '2026-03-30',
    });
    // Strip DTSTAMP lines which include current time
    const normalized = ics.replace(/^DTSTAMP:.*$/gm, 'DTSTAMP:REDACTED');
    expect(normalized).toMatchSnapshot();
  });
});
