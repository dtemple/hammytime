// Outbound billing notices — Telegram messages that originate outside the bot's own
// update handler (a Stripe webhook, later a cron). Mirrors pause.ts's sendAutoPauseNotice:
// load the athlete's chat, build the copy, send best-effort, persist an out-row. Keeping
// these here keeps the Stripe transport layer thin and colocates the bot's voice.
//
// Step 5's low-balance heads-up + final-warning notices land alongside this one.

import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/db';
import { getCreditState } from '@/server/billing/credits';
import { estimateRunwayDays, runwayLabel } from '@/server/billing/burn-rate';
import { dollarsLabel } from '@/server/billing/pricing';
import { botApiForChat } from './bot';

/**
 * Confirm a top-up in Telegram (Specs/METERING_PAYMENTS.md §6 step 5). Best-effort: the
 * credit is already committed, so a send failure must not propagate (a Stripe webhook
 * that 500s would replay the topup as a no-op and never re-send this). botApiForChat
 * routes the negative test-group chat to the staging bot like the rest of the outbound
 * paths. Call only when the topup actually landed (recordStripeTopup returned true).
 */
export async function sendTopupConfirmation(athleteId: string, grossCents: number): Promise<void> {
  try {
    const db = supabaseAdmin();
    // The chat-id read and the balance read are independent — run them together.
    const [{ data: athlete }, state] = await Promise.all([
      db.from('athletes').select('telegram_chat_id').eq('id', athleteId).maybeSingle(),
      getCreditState(athleteId),
    ]);
    if (!athlete?.telegram_chat_id) return;

    const balanceCents = state?.balanceCents ?? grossCents;
    const days = await estimateRunwayDays(balanceCents, athleteId);
    const text = `${dollarsLabel(grossCents)} added — you're at ${dollarsLabel(
      balanceCents,
    )}, ${runwayLabel(days)} at your pace.`;

    const chatId = athlete.telegram_chat_id;
    await botApiForChat(chatId).sendMessage(chatId, text);
    await db
      .from('messages')
      .insert({ athlete_id: athleteId, channel: 'tg', direction: 'out', body: text });
  } catch (err) {
    // Credit already landed; the confirmation is cosmetic. Log and move on.
    Sentry.captureException(err);
    console.warn(`[stripe] topup confirmation send failed for athlete ${athleteId}:`, err);
  }
}
