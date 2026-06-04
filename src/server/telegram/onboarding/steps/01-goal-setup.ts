import { InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import { lookupRace, type FoundRace, type RaceLookupResult } from '@/server/agent/race-lookup';
import { parseDateFlexible } from '../parsing/dates';
import { parseDistanceMiles } from '../parsing/distance';
import { upsertTrainingProfile, type GoalDistance } from '../athlete-training-profile';
import { backOnlyKeyboard, isCancelPhrase, withBack } from '../back';
import type { OnboardingStep, StepHandleResult } from '../types';

// Beats A2 (goal type) + A4 (named race) + A4b (no race yet — distance + timeframe).
// One step so the day-to-day / race / no-race branches are intra-step sub_step
// transitions rather than impossible cross-step jumps in the integer-index model.
//
// In v2 the day-to-day path is "coming soon" (a no-op alert), so this step produces
// one of two goal states: committed (a named, confirmed race) or intended (A4b).

type ConfirmedRace = {
  name: string;
  date: string | null;
  distance_mi: number | null;
  elevation_ft: number | null;
  terrain: string | null;
  source_url: string | null;
};

type GoalSubStep =
  | 'goal_choice'
  | 'race_choice'
  | 'race_name'
  | 'race_confirm'
  | 'race_manual_date'
  | 'race_manual_distance'
  | 'distance'
  | 'timeframe';

type GoalPartial = {
  sub_step: GoalSubStep;
  race_lookup?: RaceLookupResult;
  race_manual?: { name: string; date?: string | null; distance_mi?: number | null };
  goal_race?: ConfirmedRace;
  goal_distance?: GoalDistance;
  target_date?: string | null;
};

function asPartial(p: Record<string, unknown>): GoalPartial {
  return Object.keys(p).length === 0 ? { sub_step: 'goal_choice' } : (p as GoalPartial);
}

const INITIAL_PROMPT = 'What is your goal?';
const RACE_CHOICE_PROMPT =
  "What's the race? Write the name, location and/or date and it'll pull the rest. Haven't picked one? That's ok too.";
const RACE_NAME_PROMPT = "What's the race? Write the name and any details, like 'Boston Marathon'.";
const MANUAL_DATE_PROMPT = "What's the race date? (e.g. Oct 4 2026, or 'skip')";
const MANUAL_DISTANCE_PROMPT = "What's the distance? (e.g. marathon, half, 10k, or 26.2 mi)";
const DISTANCE_PROMPT = 'What are you building toward?';
const TIMEFRAME_PROMPT = 'Roughly when?';

function goalKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Train for a race', 'goal:race')
    .row()
    .text('Day-to-day running — coming soon', 'goal:daytoday');
}

function raceChoiceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Enter race name', 'race:name')
    .row()
    .text('No race yet →', 'race:none');
}

function distanceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('5K', 'dist:5k')
    .text('10K', 'dist:10k')
    .text('Half', 'dist:half')
    .row()
    .text('Marathon', 'dist:marathon')
    .row()
    .text('Just keep me fit', 'dist:keep_fit');
}

function timeframeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('~8 weeks', 'tf:8')
    .text('~12 weeks', 'tf:12')
    .row()
    .text('16+ weeks', 'tf:16')
    .text('No timeline', 'tf:none');
}

function raceDetailsLine(r: FoundRace | ConfirmedRace): string {
  const parts: string[] = [];
  if (r.date) parts.push(r.date);
  if (r.distance_mi) parts.push(`${r.distance_mi} mi`);
  if (r.terrain) parts.push(r.terrain);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function distanceMiToGoal(mi: number | null): GoalDistance | null {
  if (mi == null) return null;
  if (Math.abs(mi - 3.1) < 0.4) return '5k';
  if (Math.abs(mi - 6.2) < 0.6) return '10k';
  if (Math.abs(mi - 13.1) < 0.8) return 'half';
  if (Math.abs(mi - 26.2) < 1.2) return 'marathon';
  return null;
}

function foundToConfirmed(f: FoundRace): ConfirmedRace {
  return {
    name: f.canonical_name,
    date: f.date ?? null,
    distance_mi: f.distance_mi ?? null,
    elevation_ft: f.elevation_ft ?? null,
    terrain: f.terrain ?? null,
    source_url: f.source_url ?? null,
  };
}

// ISO date of today + n weeks, athlete-tz-agnostic (placeholder only).
function todayPlusWeeks(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

// The screen (prompt + keyboard) for a back-target sub_step. race_confirm is never
// a back target (its prompt is built from the live lookup), so it's omitted.
function screenFor(p: GoalPartial): { prompt: string; keyboard: InlineKeyboard } {
  switch (p.sub_step) {
    case 'race_choice':
      return { prompt: RACE_CHOICE_PROMPT, keyboard: withBack(raceChoiceKeyboard()) };
    case 'race_name':
      return { prompt: RACE_NAME_PROMPT, keyboard: backOnlyKeyboard() };
    case 'race_manual_date':
      return { prompt: MANUAL_DATE_PROMPT, keyboard: backOnlyKeyboard() };
    case 'race_manual_distance':
      return { prompt: MANUAL_DISTANCE_PROMPT, keyboard: backOnlyKeyboard() };
    case 'distance':
      return { prompt: DISTANCE_PROMPT, keyboard: withBack(distanceKeyboard()) };
    case 'timeframe':
      return { prompt: TIMEFRAME_PROMPT, keyboard: withBack(timeframeKeyboard()) };
    default:
      return { prompt: INITIAL_PROMPT, keyboard: goalKeyboard() };
  }
}

// One screen back, in the linear chain through this section. race_confirm and the
// manual-date/distance text screens collapse back toward the name; the distance/
// timeframe branch collapses back toward race_choice.
const BACK_MAP: Record<GoalSubStep, GoalSubStep> = {
  goal_choice: 'goal_choice',
  race_choice: 'goal_choice',
  race_name: 'race_choice',
  race_confirm: 'race_name',
  race_manual_date: 'race_name',
  race_manual_distance: 'race_manual_date',
  distance: 'race_choice',
  timeframe: 'distance',
};

async function handleBack(partialRaw: Record<string, unknown>): Promise<StepHandleResult> {
  const p = asPartial(partialRaw);
  const target = BACK_MAP[p.sub_step] ?? 'goal_choice';
  const next: GoalPartial = { ...p, sub_step: target };
  // Drop transient lookup/branch state when returning to a fork, so re-entry is clean.
  if (target === 'goal_choice' || target === 'race_choice') {
    delete next.race_lookup;
    delete next.race_manual;
    delete next.goal_distance;
  } else if (target === 'race_name') {
    delete next.race_lookup;
    delete next.race_manual;
  }
  const screen = screenFor(next);
  return { done: false, newPartial: next, reply: screen.prompt, replyMarkup: screen.keyboard };
}

async function handleRaceName(
  name: string,
  athleteId: string,
  p: GoalPartial,
): Promise<StepHandleResult> {
  const lookup = await lookupRace(name, athleteId);

  if (!lookup.ok) {
    return {
      done: false,
      newPartial: {
        ...p,
        race_lookup: lookup,
        race_manual: { name },
        sub_step: 'race_manual_date',
      },
      reply: `Couldn't find "${name}". What's the race date? (e.g. Oct 4 2026, or 'skip')`,
      replyMarkup: backOnlyKeyboard(),
    };
  }

  if ('ambiguous' in lookup) {
    const list = lookup.ambiguous
      .map((r, i) => `${i + 1}. ${r.canonical_name}${raceDetailsLine(r)}`)
      .join('\n');
    return {
      done: false,
      newPartial: { ...p, race_lookup: lookup, race_manual: { name }, sub_step: 'race_confirm' },
      reply: `Found a few:\n\n${list}\n\nWhich one? Reply 1, 2, 3 — or "none" to enter it manually.`,
      replyMarkup: backOnlyKeyboard(),
    };
  }

  const f = lookup.found;
  const qualifier = f.confidence === 'high' ? 'Found it' : 'Possible match';
  return {
    done: false,
    newPartial: {
      ...p,
      race_lookup: lookup,
      race_manual: { name: f.canonical_name },
      sub_step: 'race_confirm',
    },
    reply: `${qualifier}: ${f.canonical_name}${raceDetailsLine(f)}\n\nIs this it? Reply yes / no.`,
    replyMarkup: backOnlyKeyboard(),
  };
}

function handleRaceConfirm(text: string, p: GoalPartial): StepHandleResult {
  const v = text.trim().toLowerCase();
  const lookup = p.race_lookup;

  if (v === 'yes' || v === 'y' || v === 'right' || v === 'correct' || v === "that's it") {
    if (lookup?.ok && 'found' in lookup) {
      return { done: true, newPartial: { ...p, goal_race: foundToConfirmed(lookup.found) } };
    }
    return {
      done: false,
      newPartial: { ...p, sub_step: 'race_manual_date' },
      reply: "What's the race date? (e.g. Oct 4 2026, or 'skip')",
      replyMarkup: backOnlyKeyboard(),
    };
  }

  const num = parseInt(v, 10);
  if (!isNaN(num) && lookup?.ok && 'ambiguous' in lookup) {
    const chosen = lookup.ambiguous[num - 1];
    if (chosen) {
      return { done: true, newPartial: { ...p, goal_race: foundToConfirmed(chosen) } };
    }
    return {
      done: false,
      newPartial: p,
      reply: `Pick a number between 1 and ${lookup.ambiguous.length}, or "none" to enter it manually.`,
      replyMarkup: backOnlyKeyboard(),
    };
  }

  if (v === 'no' || v === 'n' || v === 'wrong' || v === 'none' || v === 'manual') {
    return {
      done: false,
      newPartial: { ...p, sub_step: 'race_manual_date' },
      reply: "No problem. What's the race date? (e.g. Oct 4 2026, or 'skip')",
      replyMarkup: backOnlyKeyboard(),
    };
  }

  return {
    done: false,
    newPartial: p,
    reply: 'Reply yes / no, or a number to pick from the list.',
    replyMarkup: backOnlyKeyboard(),
  };
}

function handleManualDate(text: string, p: GoalPartial): StepHandleResult {
  const v = text.trim().toLowerCase();
  const manual = p.race_manual ?? { name: 'your goal race' };

  if (v === 'skip' || v === 'unknown' || v === 'tbd') {
    return {
      done: false,
      newPartial: {
        ...p,
        race_manual: { ...manual, date: null },
        sub_step: 'race_manual_distance',
      },
      reply: "What's the distance? (e.g. marathon, half, 10k, or 26.2 mi)",
      replyMarkup: backOnlyKeyboard(),
    };
  }

  const result = parseDateFlexible(text);
  if (!result.ok) {
    return {
      done: false,
      newPartial: p,
      reply: `${result.error} Send the date (or 'skip'):`,
      replyMarkup: backOnlyKeyboard(),
    };
  }

  return {
    done: false,
    newPartial: {
      ...p,
      race_manual: { ...manual, date: result.value },
      sub_step: 'race_manual_distance',
    },
    reply: "What's the distance? (e.g. marathon, half, 10k, or 26.2 mi)",
    replyMarkup: backOnlyKeyboard(),
  };
}

function handleManualDistance(text: string, p: GoalPartial): StepHandleResult {
  const manual = p.race_manual ?? { name: 'your goal race' };
  const v = text.trim().toLowerCase();

  let distance: number | null = null;
  if (v !== 'skip' && v !== 'unknown' && v !== 'tbd') {
    const result = parseDistanceMiles(text);
    if (!result.ok)
      return {
        done: false,
        newPartial: p,
        reply: `${result.error}`,
        replyMarkup: backOnlyKeyboard(),
      };
    distance = result.value;
  }

  const goal_race: ConfirmedRace = {
    name: manual.name,
    date: manual.date ?? null,
    distance_mi: distance,
    elevation_ft: null,
    terrain: null,
    source_url: null,
  };
  return { done: true, newPartial: { ...p, goal_race } };
}

const TEXT_SCREENS: GoalSubStep[] = [
  'race_name',
  'race_confirm',
  'race_manual_date',
  'race_manual_distance',
];

async function handleMessage(
  text: string,
  partialRaw: Record<string, unknown>,
  athleteId: string,
): Promise<StepHandleResult> {
  const p = asPartial(partialRaw);

  // On a text-entry screen, a cancel phrase ("never mind") steps back one screen
  // instead of being read as the answer.
  if (TEXT_SCREENS.includes(p.sub_step) && isCancelPhrase(text)) {
    return handleBack(p);
  }

  switch (p.sub_step) {
    case 'race_name': {
      const name = text.trim();
      if (name.length < 2 || name.length > 120) {
        return {
          done: false,
          newPartial: p,
          reply: 'Send the race name (2–120 characters).',
          replyMarkup: backOnlyKeyboard(),
        };
      }
      return handleRaceName(name, athleteId, p);
    }
    case 'race_confirm':
      return handleRaceConfirm(text, p);
    case 'race_manual_date':
      return handleManualDate(text, p);
    case 'race_manual_distance':
      return handleManualDistance(text, p);
    default:
      // A button screen is active; nudge the athlete to tap.
      return { done: false, newPartial: p, reply: 'Tap one of the buttons above to continue.' };
  }
}

async function handleCallback(
  data: string,
  partialRaw: Record<string, unknown>,
): Promise<StepHandleResult> {
  const p = asPartial(partialRaw);

  // A2 goal choice
  if (data === 'goal:race') {
    return {
      done: false,
      newPartial: { ...p, sub_step: 'race_choice' },
      reply: RACE_CHOICE_PROMPT,
      replyMarkup: withBack(raceChoiceKeyboard()),
    };
  }
  if (data === 'goal:daytoday') {
    return {
      done: false,
      newPartial: p,
      alertText: 'Day-to-day is coming soon. For now, you need to set up a race training plan.',
    };
  }

  // A4 race choice
  if (data === 'race:name') {
    return {
      done: false,
      newPartial: { ...p, sub_step: 'race_name' },
      reply: RACE_NAME_PROMPT,
      replyMarkup: backOnlyKeyboard(),
    };
  }
  if (data === 'race:none') {
    return {
      done: false,
      newPartial: { ...p, sub_step: 'distance' },
      reply:
        "No problem. We'll start training and lock a race in when you're ready. What are you building toward?",
      replyMarkup: withBack(distanceKeyboard()),
    };
  }

  // A4b distance
  if (data.startsWith('dist:')) {
    const goal_distance = data.slice('dist:'.length) as GoalDistance;
    return {
      done: false,
      newPartial: { ...p, goal_distance, sub_step: 'timeframe' },
      reply: TIMEFRAME_PROMPT,
      replyMarkup: withBack(timeframeKeyboard()),
    };
  }

  // A4b timeframe → done (intended)
  if (data.startsWith('tf:')) {
    const tf = data.slice('tf:'.length);
    const target_date = tf === 'none' ? null : todayPlusWeeks(parseInt(tf, 10));
    return { done: true, newPartial: { ...p, target_date } };
  }

  return { done: false, newPartial: p };
}

async function onComplete(athleteId: string, partialRaw: Record<string, unknown>): Promise<void> {
  const p = partialRaw as GoalPartial;
  const db = supabaseAdmin();

  if (p.goal_race) {
    // Committed race: insert the race row, then point the training profile at it.
    const { data: race } = await db
      .from('races')
      .insert({
        athlete_id: athleteId,
        name: p.goal_race.name,
        date: p.goal_race.date,
        distance_mi: p.goal_race.distance_mi,
        elevation_ft: p.goal_race.elevation_ft,
        terrain: p.goal_race.terrain,
        target_type: 'finish', // target time, if any, is collected in enrichment
        target_time_sec: null,
        status: 'upcoming',
      })
      .select('id')
      .single();

    await upsertTrainingProfile(athleteId, {
      goal_type: 'race',
      goal_state: 'committed',
      goal_distance: distanceMiToGoal(p.goal_race.distance_mi),
      target_date: p.goal_race.date,
      goal_race_id: race?.id ?? null,
    });

    const date = p.goal_race.date ?? 'TBD';
    const dist = p.goal_race.distance_mi ? `${p.goal_race.distance_mi} mi` : '—';
    await db.from('memory_files').upsert(
      {
        athlete_id: athleteId,
        file_name: 'race_calendar.md',
        content_md: `## Upcoming races\n| Date | Race | Distance | Target |\n|------|------|----------|--------|\n| ${date} | ${p.goal_race.name} | ${dist} | Finish |`,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'athlete_id,file_name' },
    );
    return;
  }

  // Intended (A4b): race wanted but not picked. No race row yet.
  await upsertTrainingProfile(athleteId, {
    goal_type: 'race',
    goal_state: 'intended',
    goal_distance: p.goal_distance ?? null,
    target_date: p.target_date ?? null,
    goal_race_id: null,
  });
}

export const goalSetupStep: OnboardingStep = {
  id: 'goal-setup',
  questions: [],
  initialPrompt: INITIAL_PROMPT,
  initialKeyboard: goalKeyboard(),
  handleMessage,
  handleCallback,
  handleBack,
  onComplete,
};
