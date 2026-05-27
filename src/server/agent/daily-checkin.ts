import * as fs from 'fs';
import * as path from 'path';
import { supabaseAdmin } from '@/lib/db';
import { anthropicClient } from '@/lib/anthropic';
import { loadAthleteData } from './byo-plan';
import * as Sentry from '@sentry/nextjs';
import { fetchRecentActivities, StravaTokenBrokenError } from '@/server/strava/activities';
import type { StravaActivitySummary } from '@/server/strava/activities';
import type { Day, Week } from '@/lib/plan-schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SONNET_MODEL = 'claude-sonnet-4-6';

// Sonnet 4.6 pricing per million tokens.
const COST_PER_M_INPUT = 3.0;
const COST_PER_M_OUTPUT = 15.0;

const CHECKIN_LOG_FILE = 'checkin_log.md';

// ---------------------------------------------------------------------------
// System prompt loader (cached after first read)
// ---------------------------------------------------------------------------

let _systemPrompt: string | null = null;

function loadSystemPrompt(): string {
  if (!_systemPrompt) {
    _systemPrompt = fs.readFileSync(
      path.join(process.cwd(), 'src', 'server', 'agent', 'prompts', 'daily-checkin.system.md'),
      'utf-8',
    );
  }
  return _systemPrompt;
}

// ---------------------------------------------------------------------------
// checkin_log.md append helper
// ---------------------------------------------------------------------------

/**
 * Appends a dated entry to checkin_log.md.
 *
 * Follows the same raw read-modify-write pattern as wellness-log.ts.
 * Do NOT use upsertMemorySection here — it does section-replace, which would
 * overwrite any prior entry with the same date header.
 */
export async function appendCheckinEntry(
  athleteId: string,
  dateStr: string,
  content: string,
): Promise<void> {
  const db = supabaseAdmin();
  const newEntry = `## ${dateStr}\n\n${content}`;

  const { data } = await db
    .from('memory_files')
    .select('content_md')
    .eq('athlete_id', athleteId)
    .eq('file_name', CHECKIN_LOG_FILE)
    .maybeSingle();

  const now = new Date().toISOString();

  if (!data) {
    const document = [
      '# Check-in Log',
      '',
      'Daily coaching responses. Append-only — do not edit or delete entries.',
      '',
      newEntry,
    ].join('\n');

    const { error } = await db.from('memory_files').upsert(
      {
        athlete_id: athleteId,
        file_name: CHECKIN_LOG_FILE,
        content_md: document,
        updated_at: now,
      },
      { onConflict: 'athlete_id,file_name' },
    );
    if (error) throw new Error(`appendCheckinEntry(create) failed: ${error.message}`);
    return;
  }

  const updated = `${data.content_md}\n\n${newEntry}`;
  const { error } = await db
    .from('memory_files')
    .update({ content_md: updated, updated_at: now })
    .eq('athlete_id', athleteId)
    .eq('file_name', CHECKIN_LOG_FILE);

  if (error) throw new Error(`appendCheckinEntry(append) failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------

function metersToMiles(m: number): string {
  return (m / 1609.34).toFixed(1);
}

function metersToFeet(m: number): string {
  return Math.round(m * 3.28084).toString();
}

function secondsToHHMM(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function formatStravaTable(activities: StravaActivitySummary[], todayDateStr: string): string {
  if (activities.length === 0) {
    return 'No Strava activities found for the past 14 days.';
  }

  const yesterdayDateStr = (() => {
    const parts = todayDateStr.split('-').map(Number) as [number, number, number];
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
  })();

  const rows = activities.map((a) => {
    const rawDate = a.start_date_local.slice(0, 10); // YYYY-MM-DD
    const date =
      rawDate === todayDateStr
        ? `${rawDate} (today)`
        : rawDate === yesterdayDateStr
          ? `${rawDate} (yesterday)`
          : rawDate;
    const distMi = metersToMiles(a.distance_m);
    const duration = secondsToHHMM(a.moving_time_s);
    const elevFt = metersToFeet(a.total_elevation_gain_m);
    const hr = a.average_heartrate != null ? `${Math.round(a.average_heartrate)}` : '—';
    return `| ${date} | ${a.type} | ${distMi} mi | ${duration} | ${elevFt} ft | ${hr} |`;
  });

  const header = '| date | type | distance | duration | elev_gain | avg_hr |';
  const sep = '|------|------|----------|----------|-----------|--------|';
  return [header, sep, ...rows].join('\n');
}

function formatDayForPrompt(day: Day | null): string {
  if (!day) return 'No planned workout for today.';

  const parts: string[] = [];

  // Lead with type + description
  parts.push(`${day.type.replace(/_/g, ' ')} — ${day.description}`);

  // Run specifics
  if (day.planned_distance_miles != null) {
    parts.push(`Distance: ${day.planned_distance_miles} miles`);
  }
  if (day.target_rpe != null) {
    parts.push(`RPE: ${day.target_rpe[0]}–${day.target_rpe[1]}`);
  }
  if (day.intensity) {
    parts.push(`Intensity: ${day.intensity}`);
  }

  // Hill repeats
  if (day.repeats != null && day.repeat_duration_sec != null) {
    parts.push(`Repeats: ${day.repeats} × ${day.repeat_duration_sec}s`);
  }
  if (day.warmup_min != null) {
    parts.push(`Warmup: ${day.warmup_min} min`);
  }

  // Tempo
  if (day.tempo_block_min != null) {
    parts.push(`Tempo block: ${day.tempo_block_min} min`);
  }

  // Strength
  if (day.planned_duration_min != null) {
    parts.push(`Duration: ${day.planned_duration_min} min`);
  }

  // Trail preference
  if (day.prefer_trail) {
    parts.push('Prefer trail.');
  }

  // Nutrition / power hike notes (long runs)
  if (day.nutrition_note) {
    parts.push(`Nutrition: ${day.nutrition_note}`);
  }
  if (day.power_hike_note) {
    parts.push(`Power hike: ${day.power_hike_note}`);
  }

  return parts.join('\n');
}

/**
 * Extracts the last N entries from checkin_log.md content.
 * Entries are separated by `## YYYY-MM-DD` headers.
 */
function extractLastCheckinEntries(md: string, count: number): string {
  if (!md) return 'No prior check-ins.';

  // Split on `## ` headers that look like dates.
  const sections = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);

  // Filter to actual date-headed entries (skip preamble if any)
  const entries = sections.filter((s) => /^## \d{4}-\d{2}-\d{2}/.test(s));

  if (entries.length === 0) return 'No prior check-ins.';

  const recent = entries.slice(-count);
  return recent.join('\n\n');
}

type WellnessInput = {
  readiness: number;
  soreness_score: number;
  soreness_body_part: string | null;
  note: string | null;
};

export function buildUserMessage(opts: {
  dateStr: string;
  weekN: number;
  dayOfWeek: string;
  athleteProfileMd: string;
  injuryLogMd: string;
  recentCheckinsMd: string;
  activities: StravaActivitySummary[];
  plannedDay: Day | null;
  wellness: WellnessInput;
  asthma: boolean;
}): string {
  const {
    dateStr,
    weekN,
    dayOfWeek,
    athleteProfileMd,
    injuryLogMd,
    recentCheckinsMd,
    activities,
    plannedDay,
    wellness,
    asthma,
  } = opts;

  const bodyPartLine = wellness.soreness_body_part
    ? `${wellness.soreness_score}/10 (${wellness.soreness_body_part})`
    : `${wellness.soreness_score}/10 (no specific area)`;

  const noteLine = wellness.note ?? 'no note';

  const asthmaLine = asthma
    ? '\nAsthma flag: Yes — avoid sustained high-intensity in cold or dry conditions.'
    : '';

  return [
    '```',
    'Today',
    `${dateStr} (week ${weekN} of plan)${asthmaLine}`,
    '',
    'Athlete profile',
    athleteProfileMd.trim() || '_No profile on record._',
    '',
    'Active injuries',
    injuryLogMd.trim() || 'No active injuries on record.',
    '',
    'Recent check-ins',
    recentCheckinsMd,
    '',
    `Last 14 days of training (from Strava)`,
    formatStravaTable(activities, dateStr),
    '',
    `Today's planned workout (week ${weekN}, ${dayOfWeek})`,
    formatDayForPrompt(plannedDay),
    '',
    "This morning's wellness battery",
    `Readiness: ${wellness.readiness}/10`,
    `Soreness: ${bodyPartLine}`,
    `Note: ${noteLine}`,
    '```',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// agent_runs persistence
// ---------------------------------------------------------------------------

export async function persistRun(
  athleteId: string,
  startedAt: string,
  inputTokens: number,
  outputTokens: number,
  resultSummary: string,
  error?: string,
): Promise<void> {
  const costUsd =
    (inputTokens / 1_000_000) * COST_PER_M_INPUT + (outputTokens / 1_000_000) * COST_PER_M_OUTPUT;

  // TODO: kind "daily_checkin" is not in the agent_runs CHECK constraint
  // ('daily', 'adhoc', 'weekly', 'plan_validate'). This insert silently fails.
  // Fix: add a migration to include 'daily_checkin' in the constraint.
  await supabaseAdmin()
    .from('agent_runs')
    .insert({
      athlete_id: athleteId,
      kind: 'daily_checkin',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      model: SONNET_MODEL,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      result_summary: resultSummary.slice(0, 200),
      ...(error ? { error } : {}),
    });
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

type ActivePlan = {
  startDate: string;
  planJson: unknown;
};

async function loadActivePlan(athleteId: string): Promise<ActivePlan | null> {
  const db = supabaseAdmin();

  // Get the plan row for start_date.
  const { data: planRow } = await db
    .from('plans')
    .select('id, start_date')
    .eq('athlete_id', athleteId)
    .maybeSingle();

  if (!planRow) return null;

  // Get the active plan version.
  const { data: versionRow } = await db
    .from('plan_versions')
    .select('plan_json')
    .eq('plan_id', planRow.id)
    .eq('status', 'active')
    .maybeSingle();

  if (!versionRow?.plan_json) return null;

  return { startDate: planRow.start_date, planJson: versionRow.plan_json };
}

function computePlanWeek(startDate: string): number {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const elapsed = Date.now() - new Date(startDate).getTime();
  return Math.max(1, Math.floor(elapsed / msPerWeek) + 1);
}

function todayDayOfWeek(tz: string): string {
  // Returns full day name, e.g. "Monday"
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
  }).format(new Date());
}

function todayDateStr(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(new Date())
    .filter((p) => p.type !== 'literal')
    .map((p) => p.value)
    .join('-');
}

function extractPlannedDay(planJson: unknown, weekN: number, dayOfWeek: string): Day | null {
  const plan = planJson as { weeks?: Week[] };
  if (!plan?.weeks) return null;

  const week = plan.weeks.find((w) => w.week_number === weekN);
  if (!week) return null;

  const day = week.days.find((d) => d.day.toLowerCase() === dayOfWeek.toLowerCase());
  return day ?? null;
}

// ---------------------------------------------------------------------------
// Memory file loaders
// ---------------------------------------------------------------------------

async function loadMemoryFile(athleteId: string, fileName: string): Promise<string> {
  const { data } = await supabaseAdmin()
    .from('memory_files')
    .select('content_md')
    .eq('athlete_id', athleteId)
    .eq('file_name', fileName)
    .maybeSingle();
  return data?.content_md ?? '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs the daily coaching check-in for an athlete after the wellness battery.
 *
 * Single Claude call — no tool loop. All context is pre-loaded into the user
 * message. The system prompt is loaded from
 * src/server/agent/prompts/daily-checkin.system.md.
 *
 * Returns:
 * - telegramMessage: the coaching response text, ready to send to Telegram.
 * - checkinLogEntry: the same text, named semantically for the caller.
 */
export async function runDailyCheckin(
  athleteId: string,
  wellnessEntry: WellnessInput,
): Promise<{ telegramMessage: string; checkinLogEntry: string }> {
  const startedAt = new Date().toISOString();

  // Load all context in parallel (Strava fetched separately — see below).
  const [athleteData, injuryLogMd, checkinLogMd, activePlan] = await Promise.all([
    loadAthleteData(athleteId),
    loadMemoryFile(athleteId, 'injury_log.md'),
    loadMemoryFile(athleteId, CHECKIN_LOG_FILE),
    loadActivePlan(athleteId),
  ]);

  // Fetch Strava data before any LLM work. Caller (dispatcher) must have already
  // verified hasStravaConnection — if the token is broken we record the failure
  // and throw so no LLM tokens are wasted.
  let activities: StravaActivitySummary[];
  try {
    activities = await fetchRecentActivities(athleteId, 14);
  } catch (err) {
    console.error('[daily-checkin] Strava token broken for athlete', athleteId, err);
    Sentry.captureException(err);
    await persistRun(
      athleteId,
      startedAt,
      0,
      0,
      'aborted: broken strava token',
      'strava_token_broken',
    ).catch(() => {});
    throw new StravaTokenBrokenError(err);
  }

  const { athlete, profileMd } = athleteData;
  const tz = athlete.timezone ?? 'America/Los_Angeles';

  // Compute plan context.
  const weekN = activePlan ? computePlanWeek(activePlan.startDate) : 1;
  const dayOfWeek = todayDayOfWeek(tz);
  const dateStr = todayDateStr(tz);
  const plannedDay = activePlan ? extractPlannedDay(activePlan.planJson, weekN, dayOfWeek) : null;

  // Extract last 5 check-in entries for context.
  const recentCheckinsMd = extractLastCheckinEntries(checkinLogMd, 5);

  // Build the user message.
  const userMessage = buildUserMessage({
    dateStr,
    weekN,
    dayOfWeek,
    athleteProfileMd: profileMd,
    injuryLogMd,
    recentCheckinsMd,
    activities,
    plannedDay,
    wellness: wellnessEntry,
    asthma: athlete.asthma,
  });

  // Call Claude.
  const response = await anthropicClient().messages.create({
    model: SONNET_MODEL,
    max_tokens: 2000,
    system: loadSystemPrompt(),
    messages: [{ role: 'user', content: userMessage }],
  });

  const responseText = response.content[0]?.type === 'text' ? response.content[0].text : '';

  // Persist agent_runs row (non-fatal).
  await persistRun(
    athleteId,
    startedAt,
    response.usage.input_tokens,
    response.usage.output_tokens,
    responseText,
  ).catch(() => {
    /* non-fatal */
  });

  return { telegramMessage: responseText, checkinLogEntry: responseText };
}
