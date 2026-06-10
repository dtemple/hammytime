import ical, { ICalCalendar } from 'ical-generator';
import { isPlaceholderRace, type Plan } from './plan-schema';
import { planToCalendarEvents } from './calendar-events';

type RenderInput = {
  athleteName: string;
  timezone: string;
  plan: Plan | null;
  // The plan id (stable across versions), not the version id — so a coach edit
  // that bumps the working version keeps event UIDs stable and only changed
  // days move, instead of every event being dropped and re-added.
  planId: string | null;
  planStartDate: string | null; // ISO yyyy-mm-dd from plans.start_date
};

// Build a Date at 12:00 UTC for the given calendar date. Noon UTC stays on the
// same calendar day in every timezone the bot is likely to encounter, so when
// ical-generator formats an all-day event in the calendar's timezone the
// resulting YYYYMMDD matches the input date.
function noonUtc(iso: string): Date {
  const parts = iso.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function applyCalendarMeta(cal: ICalCalendar, input: RenderInput): void {
  cal.name(input.athleteName ? `Daybreak running — ${input.athleteName}` : 'Daybreak running');
  cal.timezone(input.timezone);
  cal.ttl(60 * 60); // PT1H refresh hint
  if (input.plan) {
    const race = input.plan.metadata.race;
    // keep_fit / intended plans carry a synthetic metadata.race (the schema
    // requires one) — its fabricated name·date must not surface here.
    cal.description(
      isPlaceholderRace(race) ? 'Rolling training plan — no race set' : `${race.name} · ${race.date}`,
    );
  } else {
    cal.description('no active training plan.');
  }
}

export function renderPlanIcs(input: RenderInput): string {
  const cal = ical({});
  applyCalendarMeta(cal, input);

  for (const e of planToCalendarEvents(input)) {
    const start = noonUtc(e.date);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const event = cal.createEvent({
      id: e.uid,
      start,
      end,
      allDay: true,
      summary: e.summary,
      description: e.description,
    });
    if (e.location) {
      event.location(e.location);
    }
  }

  return cal.toString();
}
