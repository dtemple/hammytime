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
  await sendAndLogOutbound(athlete.telegram_chat_id, athlete.id, AUTO_PAUSE_NOTICE, keyboard);
}

/** Send one outbound bot message and log it to `messages`. Shared by the static,
 *  hand-written notices (auto-pause, dormant check-back nudge — and W3's pause).
 *  Throws on send failure; the caller decides whether that aborts a batch. */
async function sendAndLogOutbound(
  chatId: string,
  athleteId: string,
  body: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  await telegramBot().api.sendMessage(chatId, body, keyboard ? { reply_markup: keyboard } : {});
  await supabaseAdmin()
    .from('messages')
    .insert({ athlete_id: athleteId, channel: 'tg', direction: 'out', body });
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

// ---------------------------------------------------------------------------
// Dormant state (Onboarding v4 / V4-W2)
// ---------------------------------------------------------------------------
//
// A dormant athlete has a row + Strava connected but NO plan: reached either by
// the entry off-ramp (a no-event signup, §4.3) or — later (W3) — the post-event
// pause. Dormancy reuses the pause primitive (paused_at) so the daily cron's
// `paused_at != null` skip applies for free, but with pause_reason 'dormant' so
// clearAutoInactivityPause leaves it intact (only naming an event wakes them).

/** The one static check-back nudge (off-ramp, §4.3) — hand-written, never agent-
 *  generated: a dormant athlete has no plan and no folder to run the agent over. */
export const CHECK_BACK_NUDGE =
  'Checking in like you asked — anything on the calendar yet? A race, or a personal ' +
  "goal with a date, and I'll build you a plan for it. If not, no rush — just message " +
  'me whenever something lands.';

/**
 * Move an athlete into the dormant state: pause their daily run, mark the reason
 * 'dormant', and set (or clear) the one-shot check-back date. Used by the entry
 * off-ramp; W3's post-event pause will reuse it. No plan is committed.
 */
export async function enterDormant(athleteId: string, checkBackAt: string | null): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('athletes')
    .update({
      paused_at: new Date().toISOString(),
      pause_reason: 'dormant',
      check_back_at: checkBackAt,
    })
    .eq('id', athleteId);
  if (error) throw new Error(`enterDormant failed: ${error.message}`);
}

/**
 * Wake a dormant athlete — the single re-activation trigger (committing an event).
 * Scoped to pause_reason 'dormant' so it never clobbers an auto_inactivity or
 * manual pause (the conditional update is a no-op for those). Clears the check-back
 * date too, so a now-active athlete never gets a stale nudge. Returns whether a
 * dormant pause was cleared.
 */
export async function exitDormant(athleteId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('athletes')
    .update({ paused_at: null, pause_reason: null, check_back_at: null })
    .eq('id', athleteId)
    .eq('pause_reason', 'dormant')
    .select('id');
  if (error) throw new Error(`exitDormant failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Set (or clear) a dormant athlete's one-shot check-back date without touching
 *  the pause. Used when the off-ramp check-back chip lands after the athlete is
 *  already dormant. */
export async function setCheckBack(athleteId: string, checkBackAt: string | null): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('athletes')
    .update({ check_back_at: checkBackAt })
    .eq('id', athleteId);
  if (error) throw new Error(`setCheckBack failed: ${error.message}`);
}

/**
 * Fire the one-shot off-ramp check-back nudge for every athlete whose check_back_at
 * has come due, then null it so it never repeats (§4.3). Called by the daily cron
 * on every hourly tick (not timezone-gated — a day's resolution is fine for a
 * months-out nudge). Nulls only on a successful send, so a transient Telegram
 * error retries next tick rather than silently dropping the nudge; at hourly
 * cadence there's no double-send window. Returns the count sent.
 */
export async function sweepCheckBacks(): Promise<number> {
  const nowISO = new Date().toISOString();
  const { data, error } = await supabaseAdmin()
    .from('athletes')
    .select('id, telegram_chat_id, check_back_at')
    .not('check_back_at', 'is', null)
    .lte('check_back_at', nowISO);
  if (error) throw new Error(`check-back sweep query failed: ${error.message}`);

  let sent = 0;
  for (const a of data ?? []) {
    if (!a.telegram_chat_id) {
      // No chat to nudge — clear the date so it doesn't re-query every tick.
      await supabaseAdmin().from('athletes').update({ check_back_at: null }).eq('id', a.id);
      continue;
    }
    try {
      await sendAndLogOutbound(a.telegram_chat_id, a.id, CHECK_BACK_NUDGE);
      await supabaseAdmin().from('athletes').update({ check_back_at: null }).eq('id', a.id);
      sent++;
    } catch (err) {
      // Leave check_back_at set — next tick retries. One bad send never aborts the
      // sweep (the cron guards this call too).
      console.error('[check-back sweep] nudge send failed', a.id, err);
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Manual pause / resume (METERING_PAYMENTS.md §10 — /pause, /resume)
// ---------------------------------------------------------------------------
//
// The friend-facing half of the pause primitive: /pause sets a manual, indefinite
// pause; /resume clears it and pulls today's check-in forward so coming back feels
// live. Both reuse the columns and enqueue path the auto-pause (§10.5) already
// proved out. pause_reason='manual' is the switch that keeps an inbound from
// auto-resuming (clearAutoInactivityPause), so a friend can ask an ad-hoc question
// while still on vacation. No timed form, no auto-resume — indefinite until /resume.

/**
 * Apply a manual /pause. Indefinite (no pause_resumes_at — timed pause is cut).
 * Returns 'already_paused' when any pause (manual, auto_inactivity, or dormant) is
 * already in effect, so the command can reply idempotently and leave the existing
 * reason untouched.
 */
export async function pauseAthleteManual(
  athlete: Pick<AthleteRow, 'id' | 'paused_at'>,
): Promise<'paused' | 'already_paused'> {
  if (athlete.paused_at != null) return 'already_paused';
  const { error } = await supabaseAdmin()
    .from('athletes')
    .update({ paused_at: new Date().toISOString(), pause_reason: 'manual' })
    .eq('id', athlete.id);
  if (error) throw new Error(`pauseAthleteManual failed: ${error.message}`);
  return 'paused';
}

/**
 * Clear a pause via /resume. Clears any pause reason — a friend running /resume
 * means "back on" regardless of how they were paused. Returns 'resumed' on the
 * paused→active transition, or 'not_paused' for the idempotent reply.
 *
 * Delivery of the immediate "coming back feels live" check-in is the caller's job
 * (the /resume command handler), NOT this function: it must be keyed per-/resume
 * rather than on the cron's `daily-{id}-{date}` key, because that key already
 * exists on any day the morning run fired — reusing it would silently dedup and
 * nothing would arrive. The transition gate here (only the resuming /resume returns
 * 'resumed') is what makes that one agent run per resume.
 */
export async function resumeAthlete(
  athlete: Pick<AthleteRow, 'id' | 'paused_at'>,
): Promise<'resumed' | 'not_paused'> {
  if (athlete.paused_at == null) return 'not_paused';
  const { error } = await supabaseAdmin()
    .from('athletes')
    .update({ paused_at: null, pause_reason: null })
    .eq('id', athlete.id);
  if (error) throw new Error(`resumeAthlete failed: ${error.message}`);
  return 'resumed';
}
