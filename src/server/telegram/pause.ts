// Auto-pause on inactivity (METERING_PAYMENTS.md §10.5).
//
// The product is a daily push and Telegram gives bots no read receipts, so a
// friend who goes quiet keeps drawing a daily agent run no one reads. After 5
// days of silence the enqueue cron pauses their daily check-ins and sends a
// one-tap way back. This module holds the pieces shared between the cron (the
// pause decision + the static notice) and the bot (the inbound auto-resume).

import { InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import type { Database } from '@/lib/db-types';
import { telegramBot } from './bot';

type AthleteRow = Database['public']['Tables']['athletes']['Row'];

// 5 days of silence → auto-pause. "Silence" = no inbound Telegram message
// (text or button tap); Strava uploads don't count (§10.5).
export const INACTIVITY_WINDOW_DAYS = 5;

// The resume button's callback_data. Tapping it (or sending any message) clears
// an auto_inactivity pause; see the bot's callback router and handleInboundText.
export const RESUME_AUTO_CALLBACK = 'resume:auto';

// Static, hand-written notice — NOT agent-generated. Sending this through the
// agent would spend model money to announce we're saving model money (§10.5).
export const AUTO_PAUSE_NOTICE =
  "It's been a little while since I heard from you, so I've paused your daily " +
  'check-ins. Want them back? Tap below, or just send me anything.';

/**
 * Pure inactivity decision, extracted for unit testing.
 *
 * An athlete is inactive iff they have no inbound message inside the window AND
 * they were created before the window opened. The created_at floor is the
 * new-athlete grace: a friend onboarded in the last 10 days who hasn't chatted
 * since isn't paused on day one (their onboarding inbound rows usually keep them
 * active, and created_at covers the gap if those rows are missing).
 *
 * Baseline = max(last inbound, athlete creation), per §10.5.
 */
export function isInactive(
  athlete: { id: string; created_at: string },
  activeAthleteIds: ReadonlySet<string>,
  cutoffMs: number,
): boolean {
  if (activeAthleteIds.has(athlete.id)) return false; // inbound within window
  if (new Date(athlete.created_at).getTime() >= cutoffMs) return false; // fresh-athlete floor
  return true;
}

/**
 * Days until this athlete would be auto-paused for inactivity, evaluated at
 * `nowMs`. Mirrors isInactive's baseline — max(last inbound, athlete creation) —
 * so the admin console's countdown can't drift from the cron's actual decision:
 * a value <= 0 means the next eligible cron tick will pause them. `lastInboundMs`
 * is the most recent inbound message time, or null when there's none inside the
 * window (in which case the created_at floor carries the new-athlete grace).
 */
export function daysUntilAutoPause(
  athlete: { created_at: string },
  lastInboundMs: number | null,
  nowMs: number,
): number {
  const baselineMs = Math.max(lastInboundMs ?? 0, new Date(athlete.created_at).getTime());
  const elapsedDays = (nowMs - baselineMs) / 86_400_000;
  return INACTIVITY_WINDOW_DAYS - elapsedDays;
}

/**
 * Clear an auto_inactivity pause when the athlete re-engages by sending anything.
 *
 * Deliberately scoped to pause_reason === 'auto_inactivity': a manual (§10
 * vacation) pause must NOT resume on an inbound — a friend can ask an ad-hoc
 * question while still on vacation. Same column, opposite inbound behavior,
 * gated on pause_reason. Returns true if a pause was cleared.
 */
export async function clearAutoInactivityPause(athlete: AthleteRow): Promise<boolean> {
  if (athlete.paused_at == null || athlete.pause_reason !== 'auto_inactivity') return false;
  await supabaseAdmin()
    .from('athletes')
    .update({ paused_at: null, pause_reason: null })
    .eq('id', athlete.id);
  return true;
}

/**
 * Send the one static auto-pause notice with a resume button, straight through
 * the prod bot (athletes have positive chat_ids). Logs the send to `messages`.
 * Throws on send failure — the caller (cron) guards it so one bad send doesn't
 * abort the batch.
 */
export async function sendAutoPauseNotice(
  athlete: Pick<AthleteRow, 'id' | 'telegram_chat_id'>,
): Promise<void> {
  if (!athlete.telegram_chat_id) return;
  const keyboard = new InlineKeyboard().text('Turn daily check-ins back on', RESUME_AUTO_CALLBACK);
  await telegramBot().api.sendMessage(athlete.telegram_chat_id, AUTO_PAUSE_NOTICE, {
    reply_markup: keyboard,
  });
  await supabaseAdmin().from('messages').insert({
    athlete_id: athlete.id,
    channel: 'tg',
    direction: 'out',
    body: AUTO_PAUSE_NOTICE,
  });
}

/**
 * Apply an inactivity pause and send the one static notice — the shared action
 * behind the admin console's MANUAL pause control. Uses pause_reason =
 * 'auto_inactivity' on purpose even when a human triggers it: the notice copy
 * ("just send me anything") promises an inbound brings them back, and only an
 * auto_inactivity pause honors that (clearAutoInactivityPause). Writes the pause
 * first, then sends; throws if the send fails (the pause is already applied), so
 * the caller can report a partial outcome.
 *
 * The inactivity cron sets the same two columns inline rather than calling this,
 * so its existing test can mock the notice send in isolation — the duplication
 * is two fields; the notice itself is shared via sendAutoPauseNotice.
 */
export async function autoPauseAthlete(
  athlete: Pick<AthleteRow, 'id' | 'telegram_chat_id'>,
): Promise<void> {
  await supabaseAdmin()
    .from('athletes')
    .update({ paused_at: new Date().toISOString(), pause_reason: 'auto_inactivity' })
    .eq('id', athlete.id);
  await sendAutoPauseNotice(athlete);
}
