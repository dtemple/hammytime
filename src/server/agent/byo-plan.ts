import * as fs from 'fs';
import * as path from 'path';
import { supabaseAdmin } from '@/lib/db';
import { sendAndLog } from '@/server/telegram/bot';
import { advanceQuestion } from '@/server/telegram/onboarding/state';
import { onboardingSteps } from '@/server/telegram/onboarding/index';
import { sendDavidAlert } from '@/server/admin/alerts';

// ---------------------------------------------------------------------------
// Template renderer
// ---------------------------------------------------------------------------

let _template: string | null = null;

export async function renderBYOPlanTemplate(values: Record<string, string>): Promise<string> {
  if (!_template) {
    _template = fs.readFileSync(
      path.join(process.cwd(), 'prompts', 'byo_plan_template.md'),
      'utf-8',
    );
  }

  let rendered = _template;

  // Strip the asthma line entirely if value is empty string
  if (values['asthma_note_if_present'] === '') {
    rendered = rendered.replace(/^.*\{\{asthma_note_if_present\}\}.*\n?/m, '');
  }

  // Replace all {{varname}} placeholders; throw on missing vars
  rendered = rendered.replace(/\{\{(\w+)\}\}/g, (match, varname: string) => {
    if (!(varname in values)) {
      throw new Error(`renderBYOPlanTemplate: missing variable "${varname}"`);
    }
    return values[varname]!;
  });

  return rendered;
}

// ---------------------------------------------------------------------------
// Shared data loader
// ---------------------------------------------------------------------------

type AthleteData = {
  id: string;
  name: string;
  dob: string | null;
  sex: string | null;
  timezone: string;
  notes: string | null;
  asthma: boolean;
  telegram_chat_id: string | null;
};

type RaceRow = {
  id: string;
  name: string;
  date: string | null;
  distance_mi: number | null;
  elevation_ft: number | null;
  terrain: string | null;
  target_type: string | null;
  target_time_sec: number | null;
  status: string;
  created_at: string;
};

type InjuryRow = {
  body_part: string;
  severity: number | null;
  status: string | null;
  notes: string | null;
};

type LoadedData = {
  athlete: AthleteData;
  goalRace: RaceRow | null;
  tuneupRaces: RaceRow[];
  pastRace: RaceRow | null;
  injuries: InjuryRow[];
  profileMd: string;
};

export async function loadAthleteData(athleteId: string): Promise<LoadedData> {
  const db = supabaseAdmin();

  const [athleteRes, racesRes, injuriesRes, profileRes] = await Promise.all([
    db
      .from('athletes')
      .select('id, name, dob, sex, timezone, notes, asthma, telegram_chat_id')
      .eq('id', athleteId)
      .single(),
    db
      .from('races')
      .select(
        'id, name, date, distance_mi, elevation_ft, terrain, target_type, target_time_sec, status, created_at',
      )
      .eq('athlete_id', athleteId)
      .order('created_at', { ascending: true }),
    db.from('injuries').select('body_part, severity, status, notes').eq('athlete_id', athleteId),
    db
      .from('memory_files')
      .select('content_md')
      .eq('athlete_id', athleteId)
      .eq('file_name', 'athlete_profile.md')
      .maybeSingle(),
  ]);

  if (athleteRes.error || !athleteRes.data) {
    throw new Error(`loadAthleteData: athlete not found ${athleteId}`);
  }

  const allRaces = racesRes.data ?? [];
  const upcomingRaces = allRaces.filter((r) => r.status === 'upcoming');
  const completedRaces = allRaces.filter((r) => r.status === 'completed');

  // goal race = first upcoming by created_at (step 2 inserts goal before tune-ups)
  const goalRace = upcomingRaces[0] ?? null;
  const tuneupRaces = upcomingRaces.slice(1);
  const pastRace = completedRaces[0] ?? null;

  return {
    athlete: athleteRes.data as AthleteData,
    goalRace,
    tuneupRaces,
    pastRace,
    injuries: (injuriesRes.data ?? []) as InjuryRow[],
    profileMd: profileRes.data?.content_md ?? '',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeAge(dob: string | null): string {
  if (!dob) return 'unknown';
  return String(new Date().getFullYear() - new Date(dob).getFullYear());
}

export function extractSection(md: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(md);
  return match ? match[1]!.trim() : '';
}

export function extractLineValue(md: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}:\\s*(.+)`).exec(md);
  return match ? match[1]!.trim() : '';
}

export function extractNotesValue(notes: string | null, label: string): string {
  if (!notes) return '';
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}:\\s*(\\d+)`).exec(notes);
  return match ? match[1]! : '';
}

function formatRaceGoalDescription(
  targetType: string | null,
  targetTimeSec: number | null,
): string {
  if (targetType === 'time' && targetTimeSec) {
    const h = Math.floor(targetTimeSec / 3600);
    const m = Math.floor((targetTimeSec % 3600) / 60);
    const s = targetTimeSec % 60;
    const timeStr = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `Time — sub-${timeStr}`;
  }
  return 'Finish — no time goal';
}

function formatFinishTimeSec(sec: number | null): string {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function buildTemplateValues(data: LoadedData): Record<string, string> {
  const { athlete, goalRace, tuneupRaces, pastRace, injuries, profileMd } = data;
  const scheduleSection = extractSection(profileMd, 'Schedule');
  const goalsSection = extractSection(profileMd, 'Goals');
  const anythingElseSection = extractSection(profileMd, 'Anything else');

  const daysPerWeek = extractLineValue(scheduleSection, 'Training days per week') || 'unknown';
  const hoursPerWeek = extractLineValue(scheduleSection, 'Hours per week') || 'unknown';
  const freeformMeaning = extractLineValue(goalsSection, 'Meaning') || 'Not provided.';

  const recentMileageMi = extractNotesValue(athlete.notes, 'Recent avg miles/week');
  const longestRecentMi = extractNotesValue(athlete.notes, 'Longest recent run');
  const longestRecentX15 = longestRecentMi
    ? String(Math.round(parseInt(longestRecentMi) * 1.5))
    : '0';

  const tuneUpRacesOrNone =
    tuneupRaces.length > 0
      ? tuneupRaces.map((r) => `${r.name} (${r.date ?? 'TBD'})`).join(', ')
      : 'None planned.';

  const pastNotableOrNone = pastRace
    ? `${pastRace.name} — ${formatFinishTimeSec(pastRace.target_time_sec)} — ${pastRace.date ?? '—'}`
    : 'None reported.';

  const injuryHistoryFormatted =
    injuries.length === 0
      ? '_No injuries flagged during onboarding._'
      : injuries
          .map((inj) => {
            const status = inj.status === 'active' ? 'currently active' : 'monitoring';
            const notes = inj.notes ? ` ${inj.notes}` : '';
            return `- **${capitalize(inj.body_part)}** — severity ${inj.severity ?? '?'}/10, ${status}.${notes}`;
          })
          .join('\n');

  const asthmaNote = athlete.asthma
    ? 'Athlete has asthma or uses an inhaler. Avoid sustained high-intensity efforts in cold/dry conditions.'
    : '';

  return {
    name: athlete.name,
    age: computeAge(athlete.dob),
    sex: athlete.sex ?? 'unknown',
    timezone: athlete.timezone,
    days_per_week: daysPerWeek,
    hours_per_week: hoursPerWeek,
    goal_race_name: goalRace?.name ?? 'Unknown',
    goal_race_date: goalRace?.date ?? 'TBD',
    distance_mi: goalRace?.distance_mi != null ? String(goalRace.distance_mi) : 'unknown',
    elevation_ft: goalRace?.elevation_ft != null ? String(goalRace.elevation_ft) : '0',
    terrain: goalRace?.terrain ?? 'unknown',
    race_goal_description: formatRaceGoalDescription(
      goalRace?.target_type ?? null,
      goalRace?.target_time_sec ?? null,
    ),
    tune_up_races_or_none: tuneUpRacesOrNone,
    past_notable_or_none: pastNotableOrNone,
    freeform_meaning: freeformMeaning,
    injury_history_formatted: injuryHistoryFormatted,
    freeform_anything_else: anythingElseSection || '_None reported._',
    recent_mileage_mi: recentMileageMi || '0',
    longest_recent_mi: longestRecentMi || '0',
    longest_recent_x_1_5: longestRecentX15,
    asthma_note_if_present: asthmaNote,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// handleBuildPath — wired via onboarding step 06-plan-fork.
// Reached when an athlete chooses "build" and has no existing plan_versions row.
// ---------------------------------------------------------------------------

export async function handleBuildPath(athleteId: string): Promise<void> {
  const db = supabaseAdmin();
  const data = await loadAthleteData(athleteId);
  const { athlete, goalRace } = data;

  if (!athlete.telegram_chat_id) {
    throw new Error(`handleBuildPath: athlete ${athleteId} has no telegram_chat_id`);
  }
  const chatId = athlete.telegram_chat_id;

  // Build and render the template
  const values = buildTemplateValues(data);
  const rendered = await renderBYOPlanTemplate(values);

  // Create the plan row
  const today = new Date().toISOString().slice(0, 10);
  const { data: planRow, error: planErr } = await db
    .from('plans')
    .insert({
      athlete_id: athleteId,
      goal_race_id: goalRace?.id ?? null,
      start_date: today,
      weeks: null,
      current_version_id: null,
    })
    .select('id')
    .single();
  if (planErr || !planRow) {
    throw new Error(`handleBuildPath: plans insert failed: ${planErr?.message}`);
  }

  const { data: versionRow, error: versionErr } = await db
    .from('plan_versions')
    .insert({
      plan_id: planRow.id,
      version: 1,
      plan_json: null,
      schema_version: 1,
      generated_by: 'athlete_llm',
      status: 'awaiting_paste',
    })
    .select('id')
    .single();
  if (versionErr || !versionRow) {
    throw new Error(`handleBuildPath: plan_versions insert failed: ${versionErr?.message}`);
  }

  // Send cover note + chunked template
  await sendAndLog(
    athleteId,
    chatId,
    `Here's your prompt — paste it into Claude or ChatGPT, work with it until the plan feels right, then paste the resulting JSON back here.`,
  );

  const CHUNK_SIZE = 4096;
  for (let i = 0; i < rendered.length; i += CHUNK_SIZE) {
    await sendAndLog(athleteId, chatId, rendered.slice(i, i + CHUNK_SIZE));
  }

  // Mark onboarding complete
  await advanceQuestion(athleteId, {
    step: onboardingSteps.length,
    question: 0,
    partial: {},
  });

  await sendDavidAlert(
    `Athlete ${athlete.name} finished onboarding (build path). BYO template sent. Awaiting paste.`,
  );
}

// ---------------------------------------------------------------------------
// handleHelpPath
// ---------------------------------------------------------------------------

export async function handleHelpPath(athleteId: string): Promise<void> {
  const data = await loadAthleteData(athleteId);
  const { athlete, goalRace, injuries } = data;

  if (!athlete.telegram_chat_id) {
    throw new Error(`handleHelpPath: athlete ${athleteId} has no telegram_chat_id`);
  }
  const chatId = athlete.telegram_chat_id;

  await sendAndLog(
    athleteId,
    chatId,
    'All set — David will reach out within 24 hours to help you build a plan. Sit tight.',
  );

  // Mark onboarding complete
  await advanceQuestion(athleteId, {
    step: onboardingSteps.length,
    question: 0,
    partial: {},
  });

  // Build richer alert for David
  const age = computeAge(athlete.dob);
  const recentAvgMi = extractNotesValue(athlete.notes, 'Recent avg miles/week') || 'unknown';
  const longestMi = extractNotesValue(athlete.notes, 'Longest recent run') || 'unknown';
  const activeInjuries = injuries
    .filter((i) => i.status === 'active')
    .map((i) => capitalize(i.body_part));
  const injuryText = activeInjuries.length > 0 ? activeInjuries.join(', ') : 'none';
  const profileMd = data.profileMd;
  const anythingElseText = extractSection(profileMd, 'Anything else') || 'none';

  const alertLines = [
    `New athlete needs a plan (help path):`,
    ``,
    `Name: ${athlete.name}, Age: ${age}`,
    goalRace
      ? `Goal race: ${goalRace.name} on ${goalRace.date ?? 'TBD'} (${goalRace.distance_mi ?? '?'} mi, ${goalRace.elevation_ft ?? '?'}ft)`
      : `Goal race: unknown`,
    `Current fitness: ${recentAvgMi} mi/week avg, ${longestMi} mi longest run`,
    `Active injuries: ${injuryText}`,
    `Anything else: ${anythingElseText}`,
  ];

  await sendDavidAlert(alertLines.join('\n'));
}
