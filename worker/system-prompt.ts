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
import type { Plan } from '@/lib/plan-schema';
import { PLAN_SHAPE_REFERENCE } from '@/lib/plan-shape-reference';
import { CANCEL_SENTINEL, loadPendingProposal, type PendingProposal } from './proposal';
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

// The prefix the renderer stamps on an ease-in week-1 coaching_note (see
// `easeInNote` in src/lib/plan-templates/renderer.ts). The worker keys on it to
// know week 1 is a partial ease-in; kept here as a local constant so the coupling
// is documented without importing from the renderer.
const EASE_IN_NOTE_PREFIX = 'Ease-in week';

function daysInclusive(fromISO: string, toISO: string): number {
  const ms = Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

// Brief the coach with the ease-in facts and the shaping instruction, but only
// while today actually sits inside a mid-week onboarder's partial week 1. The
// renderer set a conservative floor (elapsed + sign-up day rested, the rest easy,
// no long run / no quality); the coach owns how to use the days that remain given
// the runway, and the warm framing of week 2 as the first full week. Returns '' on
// every other run so the block self-suppresses mid-plan — same empty-substitution
// pattern as {{asthma_line}}.
export function easeInContext(
  plan: Plan | null | undefined,
  today: string,
  race: LoadedData['goalRace'],
): string {
  const w1 = plan?.weeks?.[0];
  if (!w1?.coaching_note?.startsWith(EASE_IN_NOTE_PREFIX)) return '';
  const start = w1.start_date;
  const end = w1.end_date;
  // A clamped far-race plan's week 1 starts in the future (today < start), so it
  // never carries the ease-in note and never matches here; the same athlete past
  // week 1 has today > end. Both fall through to ''.
  if (!start || !end || today < start || today > end) return '';

  const daysLeft = daysInclusive(today, end);
  const totalWeeks = plan!.metadata?.plan_structure?.total_weeks ?? plan!.weeks.length;
  const runway =
    race && race.date
      ? `${totalWeeks} weeks to ${race.name} on ${race.date}`
      : `a ${totalWeeks}-week plan`;

  return `## The athlete's ease-in first week

This athlete onboarded partway through the week, so week 1 is a partial ease-in. The plan set a safe floor: the days that had already passed and the sign-up day are rest, the rest of the week is easy runs, and there's no long run or hard session. Week 2 is their first full week.

What you're working with:
- Days left in this partial week: ${daysLeft} (through ${end}).
- Runway: ${runway}.

This is one of their first messages with you, so use those two numbers. A long stretch left with a short runway is worth filling: an easy run today, and an easy long run before week 2 if the days allow. A short remainder, or a long runway, stays easy — a couple of shakeouts, then a real start on Monday. Either way, tell them week 2 is where the full training begins, and treat the short week as deliberate.

The floor is your baseline; keep it. Float any extra runs as suggestions, and don't write them into marathon_training_plan.json until the athlete agrees, the same ask-first rule as any plan change. If you've already framed week 2 earlier in this thread, don't say it again — just carry on from there.`;
}

// Set on the one run right after the worker auto-extended an open-ended plan
// (GF-W1, src/server/plan/extend.ts) so the morning message announces the new
// block in the coach's voice instead of the calendar silently growing.
export type PlanExtensionInfo = { newEndDate: string; blockWeeks: number };

// Same empty-substitution pattern as {{ease_in_context}} — '' on every run
// where no extension just happened.
export function planExtensionContext(ext: PlanExtensionInfo | undefined): string {
  if (!ext) return '';
  return `## The plan was just extended

Their rolling plan was running low on future days, so the system appended the next ${ext.blockWeeks}-week block this morning — the calendar now runs through ${ext.newEndDate}. The new weeks start from their current volume; the structure carries on, it's not a new plan.

Mention it naturally in today's message — one or two sentences, in your voice: the next block is on the calendar and what its shape is (where the volume heads, where the cutback weeks land). Don't call it "the system" or describe the mechanics; it's you keeping their plan rolling. No confirmation needed from them — if they want it shaped differently, that's a normal plan-change conversation.`;
}

// Tells the coach a plan change it already proposed is still waiting on the
// athlete's tap, so it doesn't re-propose or re-ask. '' when nothing is pending
// — same empty-substitution pattern as {{ease_in_context}}.
export function pendingProposalContext(pending: PendingProposal | null): string {
  if (!pending) return '';
  const changes = pending.summary.trim() || 'a change to their plan';
  return `## A plan change is already pending their tap

You proposed a plan change earlier and they haven't tapped Yes or No yet — their calendar still shows the old version. What's pending:

${changes}

Don't propose it again or ask them to confirm it again — the button is already in front of them. If their message is them answering it, read it as their answer. If they want it shaped differently, edit \`marathon_training_plan.json\` again — your new edit replaces this pending one. If they've decided against it, write a file named \`${CANCEL_SENTINEL}\` in your folder to drop it (no plan edit needed), and tell them it's off the table.`;
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
  // No real race in both branches below — the plan file still carries a
  // metadata.race because the schema requires one. It's a synthetic
  // placeholder (renderer marks it), and the coach must never surface it.
  const placeholderNote =
    " The plan file's metadata.race is a schema-required placeholder, not a real race — never mention its name or date to the athlete.";
  if (mode === 'no_race') {
    return (
      "Goal: general fitness — no race on the calendar. Keep them consistent and healthy; build and hold an aerobic base. Don't push toward a peak or nudge them to pick a race unless they raise it." +
      placeholderNote
    );
  }
  if (mode === 'intended') {
    return (
      `Goal: a ${distanceLabel(profile?.goal_distance ?? null)} in mind — no race picked yet. Help them lock one when the timing's right; don't build a peak until a date binds.` +
      placeholderNote
    );
  }
  return 'Goal race: not set yet — confirm it before prescribing a build.';
}

// Line 3 of coach.md — the coach's mission. Race/intended athletes get the
// on-track-toward-a-race framing; a no-race athlete gets a consistency/base mission.
// Prehab cadence is owned by coach.md §Prehab + prehab_program.md, not this sentence.
function missionLine(mode: CoachMode): string {
  if (mode === 'no_race') {
    return "You coach one athlete who's running to stay fit — no race on the calendar. Your job: read their files, keep them healthy, grow their aerobic base, and make running a durable habit — giving specific, actionable guidance every time you write to them.";
  }
  return "You coach one athlete toward their goal race. Your job: read their files, judge whether they're on track, flag risks early, and give specific, actionable guidance every time you write to them.";
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

// Item 1 of the daily-run list (GF-W2). Race-ish modes keep the plan-compliance
// status line; a no-race athlete has no destination for "on track" to point at,
// so the lead is the consistency story instead. The runs-per-week target lives
// only in athlete_training_profile (it's not written to athlete_profile.md), so
// it's rendered here rather than asked of the agent.
function dailyStatusLead(mode: CoachMode, profile: LoadedData['trainingProfile']): string {
  if (mode !== 'no_race') {
    return "Today's status in a sentence or two — on track, minor concern, or off track, read off recent Strava and the plan.";
  }
  const target =
    profile?.days_per_week != null
      ? `their target of ${profile.days_per_week} runs/week`
      : 'the run days the plan prescribes';
  return (
    'Open with the consistency story in a sentence or two — with no race there is no "on track," so the question is whether the habit is holding and the base is growing. ' +
    'Read it from `strava_recent.json`: the 7- and 28-day summaries carry totals only (count, miles, minutes), so compare the 7-day total against the 28-day weekly average for the volume trend, ' +
    `check this week's runs against ${target}, and scan the activities list for how the long run is progressing. ` +
    "Lead with the one signal that's most alive this week — don't recite all three every day."
  );
}

// The through-line paragraph after the daily-run list — '' on every mode except
// no_race (GF-W2). Same empty-substitution pattern as {{ease_in_context}}.
function dailyNarrativeGuidance(mode: CoachMode): string {
  if (mode !== 'no_race') return '';
  return `With no race date doing the work, the daily message needs a through-line of its own — and the failure mode is the same message every morning ("easy 4 today, keep it conversational"). Before you write, check the last ~7 \`checkin_log.md\` entries and the recent thread for what you've been leading with, and when it's getting stale anchor today to a different thread: the long-run build, the strength habit, the wellness trend.

If \`athlete_profile.md\` carries a "North-star goal" section, that's the real target in the athlete's own words — tie the consistency story back to it when it fits, not to generic fitness.`;
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

export async function renderSystemPrompt(
  athleteId: string,
  plan?: Plan | null,
  planExtension?: PlanExtensionInfo,
): Promise<string> {
  // Independent reads — fetch concurrently rather than serially on the run path.
  const [data, template, pendingProposal] = await Promise.all([
    loadAthleteData(athleteId),
    loadTemplate(),
    loadPendingProposal(athleteId, plan ?? null),
  ]);

  const mode = coachMode(data.goalRace, data.trainingProfile);
  const { date: today } = localDateParts(data.athlete.timezone);

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
    daily_status_lead: dailyStatusLead(mode, data.trainingProfile),
    daily_narrative_guidance: dailyNarrativeGuidance(mode),
    asthma_line: data.athlete.asthma ? '- Mild asthma — watch cold/dry/high-effort conditions' : '',
    injury_history: injuryHistory(data.injuries),
    safety_caps: safetyCapsBlock(DRAFT_SAFETY_CAPS, data.goalRace?.distance_mi ?? null),
    ease_in_context: easeInContext(plan, today, data.goalRace),
    plan_extension_context: planExtensionContext(planExtension),
    pending_proposal_context: pendingProposalContext(pendingProposal),
    plan_shape_reference: PLAN_SHAPE_REFERENCE,
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
