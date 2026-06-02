// Renders the per-athlete coach system prompt from coach.md, and builds the
// per-run user prompt (M1 plan §8). Athlete facts ride in the system prompt
// (stable across the day → prompt-cacheable); the run date and source ride in
// the user prompt.

import { readFile } from 'fs/promises';
import path from 'path';
import { supabaseAdmin } from '@/lib/db';
import { loadAthleteData } from '@/server/agent/byo-plan';
import { DRAFT_SAFETY_CAPS } from '@/lib/plan-templates/caps';
import type { SafetyCaps } from '@/lib/plan-templates/types';
import type { RunSource } from './run-agent';

export type HistoryMsg = { direction: string; body: string };

// Last N Telegram messages (both directions), oldest first, so each run can
// pick up the thread instead of replying cold. The conversation lives in the
// `messages` table; the inbound message that triggered a tg_message run is
// already persisted by the webhook before the job runs, so it's usually the
// last entry here.
export async function loadRecentHistory(athleteId: string, limit = 12): Promise<HistoryMsg[]> {
  const { data } = await supabaseAdmin()
    .from('messages')
    .select('direction, body')
    .eq('athlete_id', athleteId)
    .eq('channel', 'tg')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []).reverse().map((m) => ({ direction: m.direction, body: m.body }));
}

function formatHistory(history: HistoryMsg[]): string {
  return history.map((m) => `${m.direction === 'in' ? 'Athlete' : 'Coach'}: ${m.body}`).join('\n');
}

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

function injuryHistory(injuries: Awaited<ReturnType<typeof loadAthleteData>>['injuries']): string {
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

// The athlete's long-run ceiling, picked from the per-distance caps by their
// goal-race distance (generic when there's no race on file).
function longRunCeiling(caps: SafetyCaps, distanceMi: number | null): number | null {
  if (distanceMi == null) return null;
  if (distanceMi <= 4) return caps.maxLongRunMiByDistance['5k'];
  if (distanceMi <= 7.5) return caps.maxLongRunMiByDistance['10k'];
  if (distanceMi <= 16) return caps.maxLongRunMiByDistance['half'];
  return caps.maxLongRunMiByDistance['marathon'];
}

// Render the safety caps from the single source of truth (src/lib/plan-templates/caps.ts)
// so gen-time (the rendered plan's agent_guidance) and chat-time (this prompt)
// enforce the same numbers.
export function safetyCapsBlock(caps: SafetyCaps, distanceMi: number | null): string {
  const pct = Math.round(caps.maxWeeklyRampPct * 100);
  const share = Math.round(caps.maxLongRunShareOfWeekly * 100);
  const ceiling = longRunCeiling(caps, distanceMi);
  const lines = [
    `- Weekly mileage: don't ramp more than ${pct}% or ${caps.minWeeklyRampMi} mi week to week, whichever is greater. Cutback weeks go down; re-ramping out of a cutback to the prior peak is expected.`,
    `- Long run: at most +${caps.maxLongRunStepMi} mi week to week (+${caps.postCutbackLongRunStepMi} the week after a cutback), and no more than ${share}% of that week's mileage.`,
    ceiling != null
      ? `- Long-run ceiling for this athlete's race: about ${ceiling} mi.`
      : `- Long-run ceiling by race: 5k ${caps.maxLongRunMiByDistance['5k']} / 10k ${caps.maxLongRunMiByDistance['10k']} / half ${caps.maxLongRunMiByDistance.half} / marathon ${caps.maxLongRunMiByDistance.marathon} mi.`,
    `- Keep at least ${caps.minEasyDaysBetweenHard} easy or rest day between any two hard days.`,
  ];
  return lines.join('\n');
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
    asthma_line: data.athlete.asthma ? '- Mild asthma — watch cold/dry/high-effort conditions' : '',
    injury_history: injuryHistory(data.injuries),
    safety_caps: safetyCapsBlock(DRAFT_SAFETY_CAPS, data.goalRace?.distance_mi ?? null),
  };

  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (!(key in values)) throw new Error(`renderSystemPrompt: missing placeholder "${key}"`);
    return values[key]!;
  });
}

/**
 * The per-run user prompt. For a daily check-in it's the morning trigger; for
 * an ad-hoc message it's the athlete's text. Recent thread history rides along
 * in both cases so the agent replies in context, not cold.
 */
export function buildPrompt(
  source: RunSource,
  timezone: string,
  message?: string,
  history: HistoryMsg[] = [],
): string {
  const { date, weekday } = localDateParts(timezone);
  const transcript = formatHistory(history);

  if (source === 'daily_checkin') {
    const base = `It's the morning of ${weekday}, ${date}. Write today's coaching message: read the Strava file and the athlete's memory files first, then send a training-focused note for today.`;
    return transcript ? `${base}\n\nRecent conversation, oldest first:\n${transcript}` : base;
  }

  const text = (message ?? '').trim();
  if (!transcript) {
    return `Today is ${weekday}, ${date}. The athlete sent this message:\n\n${text}\n\nReply to it.`;
  }
  const last = history[history.length - 1];
  const alreadyEndsWithLatest = last?.direction === 'in' && last.body.trim() === text;
  const thread = alreadyEndsWithLatest ? transcript : `${transcript}\nAthlete: ${text}`;
  return `Today is ${weekday}, ${date}. Recent conversation, oldest first — the athlete's latest message is the last line:\n\n${thread}\n\nReply to it.`;
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
