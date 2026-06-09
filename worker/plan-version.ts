// Staging coach plan edits as proposed candidates (Specs/CALENDAR_CONFIRM.md).
//
// The coach edits marathon_training_plan.json in its folder during a run. If
// the file changed and still validates against PlanSchema, we stage it as a
// 'proposed' plan_versions row via propose_plan_edit — current_version_id (and
// therefore the calendar) does not move. The athlete confirms with a tap on
// the keyboard run-agent sends after the coach's prose; the bot-side handler
// promotes or discards the candidate. One outstanding proposal at a time: the
// RPC discards any prior candidate, and we surface its keyboard message id so
// the caller can resolve the stale message. The original baseline_version_id
// is left untouched, so plan_drift.md keeps measuring against the original
// plan of record.
//
// We gate on schema-validity only — the same check the calendar route makes —
// not the advisory coaching caps (SPEC §17), which are warn-not-refuse in
// conversation. A schema-invalid edit is dropped; the last good version stays
// active so a broken candidate is never staged.

import { randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { supabaseAdmin } from '@/lib/db';
import type { Json } from '@/lib/db-types';
import { PlanSchema, type Plan } from '@/lib/plan-schema';
import { hash, type HydratedFolder } from './folder';

// The result of trying to stage a coach plan edit. A `dropped_*` outcome
// carries a short, already-formatted `detail` for the David alert in run-agent —
// the raw Zod error never leaves this module. A `proposed` outcome carries the
// confirm token for the keyboard, plus the prior outstanding proposal's
// keyboard message id (if one existed) so the stale message can be resolved.
export type PlanEditOutcome = {
  outcome: 'no_plan' | 'unchanged' | 'proposed' | 'dropped_invalid_json' | 'dropped_schema';
  detail?: string;
  token?: string;
  supersededMessageId?: number;
};

// Proposals die on their own: at the end of the week containing the earliest
// changed future day (athlete-local), capped at 72h from propose time.
const PROPOSAL_TTL_MS = 72 * 60 * 60 * 1000;

export async function persistPlanEdit(
  athleteId: string,
  folder: HydratedFolder,
  timezone: string,
): Promise<PlanEditOutcome> {
  if (folder.planHash === undefined) return { outcome: 'no_plan' }; // no plan at hydrate

  let raw: string;
  try {
    raw = await readFile(path.join(folder.dir, 'marathon_training_plan.json'), 'utf8');
  } catch {
    return { outcome: 'no_plan' }; // file gone — nothing to persist
  }

  if (hash(raw) === folder.planHash) return { outcome: 'unchanged' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(
      `[plan-version] athlete ${athleteId}: edited plan is not valid JSON, dropping`,
      e,
    );
    return { outcome: 'dropped_invalid_json', detail: e instanceof Error ? e.message : String(e) };
  }

  const result = PlanSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 5);
    console.error(
      `[plan-version] athlete ${athleteId}: edited plan failed schema validation, dropping ` +
        `(the last good version stays active):`,
      issues,
    );
    const detail = issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    return { outcome: 'dropped_schema', detail };
  }
  const plan = result.data;

  const db = supabaseAdmin();
  const { data: planRow } = await db
    .from('plans')
    .select('id, current_version_id, proposed_message_id')
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!planRow?.id) {
    console.warn(`[plan-version] athlete ${athleteId}: no plan row to attach the edit to`);
    return { outcome: 'no_plan' };
  }

  // 12 base64url chars — callback_data `cal:y:<token>` stays well under
  // Telegram's 64-byte cap.
  const token = randomBytes(9).toString('base64url');
  const expiresAt = proposalExpiry(folder.plan, plan, new Date(), timezone);

  const { error } = await db.rpc('propose_plan_edit', {
    p_plan_id: planRow.id,
    p_plan_json: plan as unknown as Json,
    p_based_on_version_id: planRow.current_version_id,
    p_token: token,
    p_expires_at: expiresAt.toISOString(),
  });

  if (error) {
    console.error(
      `[plan-version] athlete ${athleteId}: propose_plan_edit failed: ${error.message}`,
    );
    return { outcome: 'no_plan' };
  }
  console.log(
    `[plan-version] athlete ${athleteId}: staged a proposed plan version ` +
      `(${plan.weeks.length}w, expires ${expiresAt.toISOString()})`,
  );
  return {
    outcome: 'proposed',
    token,
    supersededMessageId: planRow.proposed_message_id ?? undefined,
  };
}

/**
 * When the staged candidate stops mattering: the end of the week containing
 * the earliest changed future day (23:59:59 athlete-local), capped at
 * propose-time + 72h. A "changed" date is one whose day JSON differs between
 * the old and new plan (added or removed dates count). With no changed day
 * after today — the coach edited a past or today line anyway — the cap alone
 * applies.
 */
export function proposalExpiry(
  oldPlan: Plan | null,
  newPlan: Plan,
  now: Date,
  timezone: string,
): Date {
  const cap = new Date(now.getTime() + PROPOSAL_TTL_MS);
  const tz = isValidTimeZone(timezone) ? timezone : 'America/Los_Angeles';
  const today = localDate(now, tz);

  const earliest = changedDates(oldPlan, newPlan)
    .filter((d) => d > today)
    .sort()[0];
  if (!earliest) return cap;

  const weekEnd = weekEndFor(earliest, newPlan) ?? weekEndFor(earliest, oldPlan);
  if (!weekEnd) return cap;

  const end = zonedEndOfDayUtc(weekEnd, tz);
  return end < cap ? end : cap;
}

// date -> the day's JSON, for diffing. Dateless days (the schema allows them)
// can't be addressed by date, so they're skipped.
function dayJsonByDate(plan: Plan | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const week of plan?.weeks ?? []) {
    for (const day of week.days) {
      if (day.date) out.set(day.date, JSON.stringify(day));
    }
  }
  return out;
}

function changedDates(oldPlan: Plan | null, newPlan: Plan): string[] {
  const before = dayJsonByDate(oldPlan);
  const after = dayJsonByDate(newPlan);
  const dates = new Set([...before.keys(), ...after.keys()]);
  return [...dates].filter((d) => before.get(d) !== after.get(d));
}

// The end date of the week containing `date`, from the week's own end_date or
// (when that optional field is missing) its latest dated day.
function weekEndFor(date: string, plan: Plan | null): string | undefined {
  for (const week of plan?.weeks ?? []) {
    const holds =
      week.days.some((d) => d.date === date) ||
      (week.start_date !== undefined &&
        week.end_date !== undefined &&
        week.start_date <= date &&
        date <= week.end_date);
    if (!holds) continue;
    if (week.end_date) return week.end_date;
    const dayDates = week.days.map((d) => d.date).filter((d): d is string => d !== undefined);
    return dayDates.sort().at(-1);
  }
  return undefined;
}

// YYYY-MM-DD for `at` in the given zone (same en-CA pattern as system-prompt.ts).
function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

// The UTC instant of 23:59:59 local on `dateISO` in `timeZone`. Start from the
// naive UTC reading, then correct by the zone's offset at that instant; the
// second pass settles a DST boundary.
function zonedEndOfDayUtc(dateISO: string, timeZone: string): Date {
  const naive = Date.parse(`${dateISO}T23:59:59Z`);
  let guess = new Date(naive);
  for (let i = 0; i < 2; i++) {
    guess = new Date(naive - tzOffsetMs(guess, timeZone));
  }
  return guess;
}

// The zone's UTC offset (ms) at the instant `at` — positive east of UTC.
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24, // Intl can emit "24" for midnight
    get('minute'),
    get('second'),
  );
  return asUtc - at.getTime();
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
