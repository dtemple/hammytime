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
  const keyboard = new InlineKeyboard().text(
    'Turn daily check-ins back on',
    RESUME_AUTO_CALLBACK,
  );
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
