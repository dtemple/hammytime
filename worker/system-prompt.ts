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

type LoadedData = Awaited<ReturnType<typeof loadAthleteData>>;

// Which of the three coaching postures this athlete is in. A real race row wins
// (committed); otherwise the structured goal_state separates an athlete who wants
// a race but hasn't picked one (intended) from a no-race base athlete (no_race).
// `unknown` is the legacy fallback (no training profile) — coached as a normal
// race athlete, preserving prior behavior.
type CoachMode = 'committed' | 'intended' | 'no_race' | 'unknown';

function coachMode(
  race: LoadedData['goalRace'],
  profile: LoadedData['trainingProfile'],
): CoachMode {
  if (race) return 'committed';
  if (profile?.goal_state === 'day_to_day') return 'no_race';
  if (profile?.goal_state === 'intended') return 'intended';
  return 'unknown';
}

function distanceLabel(distance: string | null): string {
  switch (distance) {
    case '5k':
      return '5K';
    case '10k':
      return '10K';
    case 'half':
      return 'half marathon';
    case 'marathon':
      return 'marathon';
    default:
      return 'race';
  }
}

function goalLine(
  race: LoadedData['goalRace'],
  profile: LoadedData['trainingProfile'],
  mode: CoachMode,
): string {
  if (race) {
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
  if (mode === 'no_race') {
    return "Goal: general fitness — no race on the calendar. Keep them consistent and healthy; build and hold an aerobic base. Don't push toward a peak or nudge them to pick a race unless they raise it.";
  }
  if (mode === 'intended') {
    return `Goal: a ${distanceLabel(profile?.goal_distance ?? null)} in mind — no race picked yet. Help them lock one when the timing's right; don't build a peak until a date binds.`;
  }
  return 'Goal race: not set yet — confirm it before prescribing a build.';
}

// Line 3 of coach.md — the coach's mission. Race/intended athletes get the
// on-track-toward-a-race framing; a no-race athlete gets a consistency/base mission.
function missionLine(mode: CoachMode): string {
  if (mode === 'no_race') {
    return "You coach one athlete who's running to stay fit — no race on the calendar. Your job: read their files, keep them healthy, grow their aerobic base, and make running a durable habit — giving specific, actionable guidance, including prehab, every time you write to them.";
  }
  return "You coach one athlete toward their goal race. Your job: read their files, judge whether they're on track, flag risks early, and give specific, actionable guidance — including prehab — every time you write to them.";
}

// The goal-pace bullet in "Filling known gaps". A no-race athlete has no
// target_time gap (it's suppressed at seed), so the goal-pace logic is dropped.
function targetTimeGapGuidance(mode: CoachMode): string {
  if (mode === 'no_race') {
    return "- Paces are effort-led — easy, steady, hard. There's no finish-time goal to chase, so don't ask for one unless they bring up a race.";
  }
  return '- The first goal-pace session is when `target_time` earns its ask. A time goal turns effort-led paces into concrete targets.';
}

// The parenthetical examples in the known_gaps.md file description. A no-race
// athlete never has the race-only gaps seeded, so they're left out here too.
function knownGapsExamples(mode: CoachMode): string {
  if (mode === 'no_race') {
    return 'strength equipment, schedule constraints';
  }
  return 'a finish-time goal, strength equipment, tune-up races, schedule constraints';
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

  const mode = coachMode(data.goalRace, data.trainingProfile);

  const values: Record<string, string> = {
    name: data.athlete.name,
    age: age(data.athlete.dob),
    sex: data.athlete.sex ?? 'sex unknown',
    timezone: data.athlete.timezone,
    coach_title: mode === 'no_race' ? 'Running coach' : 'Marathon coach',
    coach_mission_line: missionLine(mode),
    goal_race_line: goalLine(data.goalRace, data.trainingProfile, mode),
    target_time_gap_guidance: targetTimeGapGuidance(mode),
    known_gaps_examples: knownGapsExamples(mode),
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
 * a post-activity run it's a note about the just-completed activity; for an
 * ad-hoc message it's the athlete's text. Recent thread history rides along in
 * every case so the agent replies in context, not cold.
 */
export function buildPrompt(
  source: RunSource,
  timezone: string,
  message?: string,
  history: HistoryMsg[] = [],
  activityId?: number,
): string {
  const { date, weekday } = localDateParts(timezone);
  const transcript = formatHistory(history);

  if (source === 'daily_checkin') {
    const base = `It's the morning of ${weekday}, ${date}. Write today's coaching message: read the Strava file and the athlete's memory files first, then send a training-focused note for today.`;
    return transcript ? `${base}\n\nRecent conversation, oldest first:\n${transcript}` : base;
  }

  if (source === 'post_activity') {
    const idHint = activityId ? ` (Strava id ${activityId})` : '';
    const base = `The athlete just completed an activity${idHint} and it's on Strava — it's the most recent entry in strava_recent.json. It's ${weekday}, ${date}. Read that activity, marathon_training_plan.json, and plan_drift.md, then send a post-activity note per the "When a Strava activity just came in" section of your instructions: acknowledge this specific activity, and say whether it changes anything for the rest of this week — reassure and point ahead if not, or explain and ask whether to adjust the plan if it does. Don't change the plan yourself this turn.`;
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
