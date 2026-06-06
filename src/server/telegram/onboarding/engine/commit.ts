// Onboarding v3 (V3-W2): commit the slot state to the DB so plan generation can
// run. This is the precondition for `next_action: 'generate'` —
// generateAndPersistPlan reads athlete_training_profile (+ optional races /
// injuries), so the slots have to land in those tables first. Mirrors the writes
// the v2 steps did in their onComplete handlers (00/01/03/05), driven off the
// slot map instead of per-step partials.
//
// Where v3's slot vocabulary differs from the stored enums, the mapping happens
// in the pure helpers below: general_fitness → goal_type 'day_to_day' +
// goal_distance 'keep_fit' (the base-maintenance template), injury status 'past'
// → 'resolved', and goal_state derived from whether a race is named and dated.

import { supabaseAdmin } from '@/lib/db';
import { nominalRaceMiles } from '@/lib/plan-templates/selector';
import { upsertTrainingProfile, type TrainingProfileInsert } from '../athlete-training-profile';
import { upsertProfileSection, upsertMemorySection } from '../memory';
import { seedKnownGapsFromFilled } from '../known-gaps-memory';
import { formatFinishTime } from '../parsing/durations';
import {
  slotsToGaps,
  type GoalDistanceValue,
  type GoalTypeValue,
  type InjuryDetail,
} from '../slots/schema';
import type { V3OnboardingState } from '../slots/slot-state';

type ProfilePatch = Partial<Omit<TrainingProfileInsert, 'athlete_id'>>;

interface RaceWrite {
  name: string;
  date: string;
  distance_mi: number;
  target_type: 'finish' | 'time';
  target_time_sec: number | null;
}

export interface GoalWrite {
  /** The training-profile patch, minus goal_race_id (set after the race insert). */
  profile: ProfilePatch;
  /** The race row to insert (committed only), or null. */
  race: RaceWrite | null;
}

function slotVal<T>(state: V3OnboardingState, key: keyof V3OnboardingState['slots']): T | null {
  const slot = state.slots[key];
  return (slot?.value as T | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Pure mappers (slot vocabulary → stored enums)
// ---------------------------------------------------------------------------

/** Slot injury status (active/monitoring/past) → injuries.status
 *  (active/resolved/monitoring). */
export function mapInjuryStatus(
  status: InjuryDetail['status'],
): 'active' | 'resolved' | 'monitoring' {
  return status === 'past' ? 'resolved' : status;
}

/** Build the goal write from the slots: the training-profile patch and, for a
 *  committed race, the race row. Pure — no DB. */
export function buildGoalWrite(state: V3OnboardingState): GoalWrite {
  const base: ProfilePatch = {
    experience_tier: slotVal<string>(state, 'experience_tier'),
    days_per_week: slotVal<number>(state, 'days_per_week'),
    long_run_day: slotVal<number>(state, 'long_run_day'),
  };

  const goalType = slotVal<'race' | 'general_fitness'>(state, 'goal_type');

  // General fitness → the no-race base-maintenance plan (keep_fit).
  if (goalType === 'general_fitness') {
    return {
      profile: {
        ...base,
        goal_type: 'day_to_day',
        goal_state: 'day_to_day',
        goal_distance: 'keep_fit',
        target_date: null,
      },
      race: null,
    };
  }

  const distance = (slotVal<GoalDistanceValue>(state, 'goal_distance') ??
    'marathon') as GoalDistanceValue;
  const raceName = slotVal<string>(state, 'goal_race');
  const raceDate = slotVal<string>(state, 'goal_date');
  const targetTime = slotVal<number>(state, 'target_time');

  // An accepted out-of-catalog goal: the plan is structured toward the proxy
  // bucket, but the race row carries the athlete's REAL distance so the coach and
  // race_calendar read the truth, not the proxy's nominal mileage (V3-W8 §5.2).
  const ooc = state.out_of_catalog;
  const realDistanceMi =
    ooc?.consent === 'accepted' && ooc.distance_mi != null ? ooc.distance_mi : null;

  // Committed: a named, dated race.
  if (raceName && raceDate) {
    return {
      profile: {
        ...base,
        goal_type: 'race',
        goal_state: 'committed',
        goal_distance: distance,
        target_date: raceDate,
      },
      race: {
        name: raceName,
        date: raceDate,
        distance_mi: realDistanceMi ?? nominalRaceMiles(distance),
        target_type: targetTime ? 'time' : 'finish',
        target_time_sec: targetTime ?? null,
      },
    };
  }

  // Intended: a distance in mind, no specific race yet.
  return {
    profile: {
      ...base,
      goal_type: 'race',
      goal_state: 'intended',
      goal_distance: distance,
      target_date: raceDate ?? null,
    },
    race: null,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Write every slot to its destination table. The router commits once per
 *  onboarding (races/injuries inserts aren't idempotent). */
export async function commitSlots(athleteId: string, state: V3OnboardingState): Promise<void> {
  await commitIdentity(athleteId, state);
  await commitGoal(athleteId, state);
  await commitInjury(athleteId, state);
  await commitBackground(athleteId, state);
  // A no-race / keep_fit athlete never gets the race-only gaps (target_time,
  // tune_up_races) seeded — the non-race coach branch (V3-W7) drops that framing.
  const noRace = slotVal<GoalTypeValue>(state, 'goal_type') === 'general_fitness';
  await seedKnownGapsFromFilled(athleteId, slotsToGaps(state.slots), {
    excludeRaceOnly: noRace,
  });
}

async function commitIdentity(athleteId: string, state: V3OnboardingState): Promise<void> {
  const name = slotVal<string>(state, 'name');
  const sex = slotVal<string>(state, 'sex');
  const timezone = slotVal<string>(state, 'timezone');

  const update: { name?: string; sex?: string; timezone?: string } = {};
  if (name) update.name = name;
  if (sex) update.sex = sex;
  if (timezone) update.timezone = timezone;
  if (Object.keys(update).length > 0) {
    await supabaseAdmin().from('athletes').update(update).eq('id', athleteId);
  }

  const lines = [`- Name: ${name || 'unknown'}`];
  if (timezone) lines.push(`- Timezone: ${timezone}`);
  if (sex) lines.push(`- Sex: ${sex}`);
  await upsertProfileSection(athleteId, 'Identity', lines.join('\n'));
}

async function commitGoal(athleteId: string, state: V3OnboardingState): Promise<void> {
  const { profile, race } = buildGoalWrite(state);

  let goalRaceId: string | null = null;
  if (race) {
    const { data } = await supabaseAdmin()
      .from('races')
      .insert({
        athlete_id: athleteId,
        name: race.name,
        date: race.date,
        distance_mi: race.distance_mi,
        elevation_ft: null,
        terrain: null,
        target_type: race.target_type,
        target_time_sec: race.target_time_sec,
        status: 'upcoming',
      })
      .select('id')
      .single();
    goalRaceId = data?.id ?? null;
  }

  await upsertTrainingProfile(athleteId, { ...profile, goal_race_id: goalRaceId });

  // Store the true goal in the athlete's own words (V3-W8 §5.2): the plan is built
  // toward the marathon-proxy, but the daily coach needs to know the real target.
  const ooc = state.out_of_catalog;
  if (ooc?.consent === 'accepted') {
    const miles = ooc.distance_mi != null ? ` (~${Math.round(ooc.distance_mi)} mi)` : '';
    await upsertProfileSection(
      athleteId,
      'North-star goal',
      `- ${ooc.words}${miles}\n- The structured plan is a ${ooc.proxy} block as a proxy — this is the real target the athlete is chasing.`,
    );
  }

  if (race) {
    const target = race.target_time_sec ? formatFinishTime(race.target_time_sec) : 'Finish';
    await supabaseAdmin()
      .from('memory_files')
      .upsert(
        {
          athlete_id: athleteId,
          file_name: 'race_calendar.md',
          content_md: `## Upcoming races\n| Date | Race | Distance | Target |\n|------|------|----------|--------|\n| ${race.date} | ${race.name} | ${race.distance_mi} mi | ${target} |`,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'athlete_id,file_name' },
      );
  }
}

async function commitInjury(athleteId: string, state: V3OnboardingState): Promise<void> {
  const detail = slotVal<InjuryDetail>(state, 'injury_detail');
  if (!detail?.body_part) return; // none / unknown / skipped → no injury row.

  const status = mapInjuryStatus(detail.status);
  const { error } = await supabaseAdmin().from('injuries').insert({
    athlete_id: athleteId,
    body_part: detail.body_part,
    severity: null,
    status,
    notes: null,
    started_at: new Date().toISOString(),
  });
  if (error) throw new Error(`injuries insert failed: ${error.message}`);

  const label =
    status === 'active'
      ? 'currently bothering them'
      : status === 'monitoring'
        ? 'watching it'
        : 'past issue';
  await upsertProfileSection(athleteId, 'Injury history', `- ${detail.body_part} — ${label}`);
  await upsertMemorySection(
    athleteId,
    'injury_log.md',
    'Active injuries',
    `- **${detail.body_part}** — ${label} (from onboarding).`,
  );
}

// Optional context the daily coach reads as prose. Stated-only, mirroring the v2
// enrichment Background section.
async function commitBackground(athleteId: string, state: V3OnboardingState): Promise<void> {
  const stated = <T>(key: keyof V3OnboardingState['slots']): T | null => {
    const slot = state.slots[key];
    return slot && slot.provenance === 'stated' && slot.value != null ? (slot.value as T) : null;
  };

  const lines: string[] = [];
  const age = stated<number>('age');
  if (age != null) lines.push(`- Age: ${age}`);
  const targetTime = stated<number>('target_time');
  if (targetTime != null) lines.push(`- Goal time: ${formatFinishTime(targetTime)}`);
  const schedule = stated<string>('schedule_constraints');
  if (schedule) lines.push(`- Schedule: ${schedule}`);
  const strength = stated<string>('strength_equipment');
  if (strength) lines.push(`- Strength access: ${strength}`);
  const motivation = stated<string>('motivation');
  if (motivation) lines.push(`- Motivation: ${motivation}`);

  if (lines.length > 0) await upsertProfileSection(athleteId, 'Background', lines.join('\n'));
}
