// Worker-side helpers for the outstanding plan proposal an athlete hasn't yet
// confirmed (Specs/CALENDAR_CONFIRM.md). The coach edits
// marathon_training_plan.json, persistPlanEdit stages that edit as a `proposed`
// plan_versions row, and run-agent sends a Yes/No button. Until the athlete
// taps, the proposal sits pending — `current_version_id` (and the calendar)
// stay on the active version.
//
// This module gives the coach awareness of that pending state on its next run
// (loadPendingProposal → a system-prompt block) and a way to cancel it without
// staging a replacement (discardPendingProposal, driven by a folder sentinel).

import { supabaseAdmin } from '@/lib/db';
import type { Day, Plan } from '@/lib/plan-schema';

// The agent drops a pending proposal by writing this dotfile into its folder.
// A dotfile so syncBack skips it (folder.ts) and it never lands in memory_files.
export const CANCEL_SENTINEL = '.cancel_pending_change';

export type PendingProposal = {
  // Human-readable list of the day changes the proposal would make, one per line.
  summary: string;
  // ISO timestamp the proposal expires (when its button stops mattering).
  expiresAt: string | null;
};

// Compact label for a day: "tempo 4mi", "rest", "long run 12mi".
function dayLabel(day: Day): string {
  const kind = day.type.replace(/_/g, ' ');
  const dist = day.planned_distance_miles;
  return dist ? `${kind} ${dist}mi` : kind;
}

function daysByDate(plan: Plan | null): Map<string, Day> {
  const out = new Map<string, Day>();
  for (const week of plan?.weeks ?? []) {
    for (const day of week.days) {
      if (day.date) out.set(day.date, day);
    }
  }
  return out;
}

// "Thu Jun 25" — weekday + month/day for a plain YYYY-MM-DD (read as UTC noon so
// the calendar date never slips across a timezone boundary).
function dateLabel(dateISO: string): string {
  const at = new Date(`${dateISO}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(at);
  const monthDay = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(at);
  return `${weekday} ${monthDay}`;
}

// The day-by-day difference between the active plan and a proposed one, rendered
// as one line per changed dated day. Mirrors the date-keyed diff persistPlanEdit
// uses for expiry, but renders the change for a human rather than just flagging it.
export function diffSummary(activePlan: Plan | null, proposedPlan: Plan): string {
  const before = daysByDate(activePlan);
  const after = daysByDate(proposedPlan);
  const dates = [...new Set([...before.keys(), ...after.keys()])].sort();

  const lines: string[] = [];
  for (const date of dates) {
    const b = before.get(date);
    const a = after.get(date);
    if (b && a) {
      if (JSON.stringify(b) === JSON.stringify(a)) continue;
      lines.push(`${dateLabel(date)}: ${dayLabel(b)} → ${dayLabel(a)}`);
    } else if (a) {
      lines.push(`${dateLabel(date)}: added ${dayLabel(a)}`);
    } else if (b) {
      lines.push(`${dateLabel(date)}: removed (was ${dayLabel(b)})`);
    }
  }
  return lines.join('\n');
}

// The pending proposal for an athlete, or null when none is outstanding. An
// expired proposal is treated as none — the coach shouldn't be told to wait on
// a button that no longer applies (the cron sweep clears the row itself).
export async function loadPendingProposal(
  athleteId: string,
  activePlan: Plan | null,
  now: Date = new Date(),
): Promise<PendingProposal | null> {
  const db = supabaseAdmin();
  const { data: plan } = await db
    .from('plans')
    .select('proposed_version_id, proposed_expires_at')
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!plan?.proposed_version_id) return null;
  if (plan.proposed_expires_at && new Date(plan.proposed_expires_at) < now) return null;

  const { data: version } = await db
    .from('plan_versions')
    .select('plan_json, status')
    .eq('id', plan.proposed_version_id)
    .maybeSingle();

  if (version?.status !== 'proposed' || version.plan_json == null) return null;

  // The proposed json was schema-validated when persistPlanEdit staged it, so we
  // cast and read it defensively (same posture as folder.ts with the working
  // plan) rather than re-running the schema here.
  const proposedPlan = version.plan_json as unknown as Plan;

  return {
    summary: diffSummary(activePlan, proposedPlan),
    expiresAt: plan.proposed_expires_at ?? null,
  };
}

// Drops the athlete's outstanding proposal without staging a replacement —
// driven by the coach writing the CANCEL_SENTINEL file. Returns whether a
// proposal was actually discarded and the stale button's message id (read
// before the RPC clears it) so the caller can resolve it.
export async function discardPendingProposal(
  athleteId: string,
): Promise<{ discarded: boolean; staleMessageId?: number }> {
  const db = supabaseAdmin();
  const { data: plan } = await db
    .from('plans')
    .select('id, proposed_token, proposed_message_id, proposed_version_id')
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!plan?.proposed_version_id || !plan.proposed_token) return { discarded: false };

  const { data: result, error } = await db.rpc('discard_proposed_version', {
    p_plan_id: plan.id,
    p_token: plan.proposed_token,
  });
  if (error) {
    console.error(`[proposal] discardPendingProposal failed for ${athleteId}: ${error.message}`);
    return { discarded: false };
  }

  return {
    discarded: result === 'discarded',
    staleMessageId: plan.proposed_message_id ?? undefined,
  };
}
