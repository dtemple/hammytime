import ical, { ICalCalendar } from 'ical-generator';
import type { Day, Plan, Week } from './plan-schema';
import { resolveExercise } from './exercise-library';

type StrengthSession = NonNullable<Plan['strength_workouts']>['upper_body'];

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

const SUMMARY_MAP: Record<Day['type'], { emoji: string; label: string }> = {
  long_run: { emoji: '🏃', label: 'Long Run' },
  easy: { emoji: '🐢', label: 'Easy' },
  easy_with_strides: { emoji: '🐢', label: 'Easy + Strides' },
  hill_repeats: { emoji: '⛰️', label: 'Hills' },
  intervals: { emoji: '🔥', label: 'Intervals' },
  trail_tempo: { emoji: '💨', label: 'Trail Tempo' },
  tempo: { emoji: '💨', label: 'Tempo' },
  upper_body_strength: { emoji: '💪', label: 'Upper Body' },
  lower_body_strength: { emoji: '🦵', label: 'Lower Body' },
  race: { emoji: '🏁', label: 'Race' },
  rest: { emoji: '🛌', label: 'Rest' },
};

// Build a Date at 12:00 UTC for the given calendar date. Noon UTC stays on the
// same calendar day in every timezone the bot is likely to encounter, so when
// ical-generator formats an all-day event in the calendar's timezone the
// resulting YYYYMMDD matches the input date.
function noonUtc(iso: string, offsetDays = 0): Date {
  const parts = iso.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return new Date(Date.UTC(y, m - 1, d + offsetDays, 12, 0, 0));
}

function eventDate(
  day: Day,
  week: Week,
  dayIndex: number,
  planStartDate: string | null,
): Date | null {
  if (day.date) return noonUtc(day.date);
  if (!planStartDate) return null;
  return noonUtc(planStartDate, (week.week_number - 1) * 7 + dayIndex);
}

function summaryFor(day: Day): string {
  const { emoji, label } = SUMMARY_MAP[day.type];
  let suffix = '';
  if (
    (day.type === 'long_run' ||
      day.type === 'easy' ||
      day.type === 'easy_with_strides' ||
      day.type === 'hill_repeats' ||
      day.type === 'intervals' ||
      day.type === 'trail_tempo' ||
      day.type === 'tempo' ||
      day.type === 'race') &&
    typeof day.planned_distance_miles === 'number'
  ) {
    suffix = ` ${day.planned_distance_miles}mi`;
  } else if (
    (day.type === 'upper_body_strength' || day.type === 'lower_body_strength') &&
    typeof day.planned_duration_min === 'number'
  ) {
    suffix = ` ${day.planned_duration_min}min`;
  }
  return `${emoji} ${label}${suffix}`;
}

function renderExercise(
  ex: NonNullable<StrengthSession>['exercises'][number],
  taper: boolean,
): string {
  // Append the corpus source link when the exercise resolves. A calendar
  // DESCRIPTION is plain text, so a bare URL is correct here (the one place it
  // is). Unmatched → no link, line unchanged. Never a fabricated URL.
  const entry = resolveExercise({ slug: ex.exercise_slug, name: ex.name });
  const link = entry ? ` ${entry.source}` : '';

  if (ex.duration_min !== undefined) {
    const dur =
      taper && ex.taper_duration_min !== undefined ? ex.taper_duration_min : ex.duration_min;
    const areas = ex.areas && ex.areas.length > 0 ? ` (${ex.areas.join(', ')})` : '';
    return `- ${ex.name} — ${dur} min${areas}${link}`;
  }
  const sets = taper && ex.taper_sets !== undefined ? ex.taper_sets : ex.sets;
  const reps = taper && ex.taper_reps !== undefined ? ex.taper_reps : ex.reps;
  if (sets === undefined || reps === undefined) return `- ${ex.name}${link}`;
  const unit = ex.reps_unit ? ` ${ex.reps_unit}` : '';
  return `- ${ex.name} — ${sets}×${reps}${unit}${link}`;
}

function strengthSessionFor(plan: Plan, day: Day): StrengthSession | undefined {
  if (day.type === 'upper_body_strength') return plan.strength_workouts?.upper_body;
  if (day.type === 'lower_body_strength') return plan.strength_workouts?.lower_body;
  return undefined;
}

function descriptionFor(day: Day, plan: Plan): string {
  const lines: string[] = [];
  const isStrength = day.type === 'upper_body_strength' || day.type === 'lower_body_strength';
  const session = isStrength ? strengthSessionFor(plan, day) : undefined;

  if (!isStrength || !session) {
    lines.push(day.description);
  }

  if (day.intensity) lines.push(`Intensity: ${day.intensity}`);
  if (day.target_rpe) lines.push(`RPE ${day.target_rpe[0]}–${day.target_rpe[1]}`);

  if (isStrength && session) {
    lines.push('');
    lines.push('## Exercises');
    const taper = day.use_taper_sets === true;
    for (const ex of session.exercises) {
      lines.push(renderExercise(ex, taper));
    }
  }

  return lines.join('\n');
}

function applyCalendarMeta(cal: ICalCalendar, input: RenderInput): void {
  cal.name(input.athleteName ? `Daybreak running — ${input.athleteName}` : 'Daybreak running');
  cal.timezone(input.timezone);
  cal.ttl(60 * 60); // PT1H refresh hint
  if (input.plan) {
    const race = input.plan.metadata.race;
    cal.description(`${race.name} · ${race.date}`);
  } else {
    cal.description('no active training plan.');
  }
}

export function renderPlanIcs(input: RenderInput): string {
  const cal = ical({});
  applyCalendarMeta(cal, input);

  if (!input.plan || !input.planId) {
    return cal.toString();
  }

  for (const week of input.plan.weeks) {
    week.days.forEach((day, dayIndex) => {
      const start = eventDate(day, week, dayIndex, input.planStartDate);
      if (!start) return;
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

      const event = cal.createEvent({
        id: `${input.planId}-w${week.week_number}-d${dayIndex}@hammytime`,
        start,
        end,
        allDay: true,
        summary: summaryFor(day),
        description: descriptionFor(day, input.plan!),
      });
      if (day.prefer_trail) {
        event.location('trail');
      }
    });
  }

  return cal.toString();
}
