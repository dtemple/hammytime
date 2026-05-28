// Renders the per-athlete coach system prompt from coach.md, and builds the
// per-run user prompt (M1 plan §8). Athlete facts ride in the system prompt
// (stable across the day → prompt-cacheable); the run date and source ride in
// the user prompt.

import { readFile } from 'fs/promises';
import path from 'path';
import { loadAthleteData } from '@/server/agent/byo-plan';
import type { RunSource } from './run-agent';

let _template: string | null = null;

async function loadTemplate(): Promise<string> {
  if (!_template) {
    _template = await readFile(path.join(__dirname, 'prompts', 'coach.md'), 'utf8');
  }
  return _template;
}

function age(dob: string | null): string {
  if (!dob) return 'age unknown';
  const years = new Date().getFullYear() - new Date(dob).getFullYear();
  return `${years}yo`;
}

function goalRaceLine(race: Awaited<ReturnType<typeof loadAthleteData>>['goalRace']): string {
  if (!race) return 'Goal race: not set yet — confirm it before prescribing a build.';
  const parts = [race.name];
  if (race.date) parts.push(race.date);
  const detail: string[] = [];
  if (race.distance_mi != null) detail.push(`${race.distance_mi} mi`);
  if (race.elevation_ft != null) detail.push(`${race.elevation_ft} ft`);
  const goal =
    race.target_type === 'time' && race.target_time_sec
      ? `sub-${formatTime(race.target_time_sec)}`
      : 'finish';
  return `Goal race: ${parts.join(', ')}${detail.length ? ` — ${detail.join(', ')}` : ''}. Target: ${goal}.`;
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function injuryHistory(
  injuries: Awaited<ReturnType<typeof loadAthleteData>>['injuries'],
): string {
  if (injuries.length === 0) return '_None flagged during onboarding._';
  return injuries
    .map((i) => {
      const status = i.status === 'active' ? 'active' : 'monitoring';
      const sev = i.severity != null ? ` (severity ${i.severity}/10, ${status})` : ` (${status})`;
      const note = i.notes ? ` — ${i.notes}` : '';
      return `- ${cap(i.body_part)}${sev}${note}`;
    })
    .join('\n');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function renderSystemPrompt(athleteId: string): Promise<string> {
  const data = await loadAthleteData(athleteId);
  const template = await loadTemplate();

  const values: Record<string, string> = {
    name: data.athlete.name,
    age: age(data.athlete.dob),
    sex: data.athlete.sex ?? 'sex unknown',
    timezone: data.athlete.timezone,
    goal_race_line: goalRaceLine(data.goalRace),
    asthma_line: data.athlete.asthma
      ? '- Mild asthma — watch cold/dry/high-effort conditions'
      : '',
    injury_history: injuryHistory(data.injuries),
  };

  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (!(key in values)) throw new Error(`renderSystemPrompt: missing placeholder "${key}"`);
    return values[key]!;
  });
}

/**
 * The per-run user prompt. For a daily check-in it's the morning trigger; for
 * an ad-hoc message it's the athlete's text, wrapped with the local date so the
 * agent anchors "today" correctly.
 */
export function buildPrompt(source: RunSource, timezone: string, message?: string): string {
  const { date, weekday } = localDateParts(timezone);
  if (source === 'daily_checkin') {
    return `It's the morning of ${weekday}, ${date}. Run today's coaching check-in. Read the Strava file and the athlete's memory files first, then write today's message.`;
  }
  const text = (message ?? '').trim();
  return `Today is ${weekday}, ${date}. The athlete sent this message:\n\n${text}\n\nReply to it.`;
}

function localDateParts(timezone: string): { date: string; weekday: string } {
  const tz = isValidTimeZone(timezone) ? timezone : 'America/Los_Angeles';
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
  }).format(now);
  return { date, weekday };
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
