import { InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import { botApiForChat } from '../bot';
import {
  fetchRecentActivities,
  getLoggedInAthlete,
  deriveTimezone,
  getFitnessSnapshot,
} from '@/server/strava/activities';
import { advanceIfSubstep, loadOnboardingState } from './state';
import { tzLabel } from './timezones';
import { slotValue } from './slots/provenance';
import {
  initialV3State,
  isV3Enabled,
  seedStravaInferences,
  seedV3IfAwaitingStrava,
} from './slots/slot-state';
import type { ProfileConfirmPartial } from './steps/00-profile-confirm';
import type { OnboardingState } from './types';

// Onboarding v3 (V3-W2): the A1→v3 handoff. The orientation sets expectations
// before the conversational flow's slower (Sonnet) turns — without it, the
// thinking pauses read as a stuck bot.
function orientationMessage(firstname: string | null): string {
  const opener = firstname
    ? `Okay ${firstname}, let's get you set up.`
    : "Okay, let's get you set up.";
  return [
    `${opener} I'll ask about three things: your running goals, where your training's at right now, and any injuries to keep an eye on.`,
    'Talk to me normally — hit the mic and ramble if it helps, the more context the better. It takes a few minutes, and I might pause sometimes to think. You can change your answers later by tapping the menu button below.',
    'Ready?',
  ].join('\n\n');
}

async function sendWithKeyboard(
  athleteId: string,
  chatId: number | string,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  await botApiForChat(chatId).sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : {});
  await supabaseAdmin().from('messages').insert({
    athlete_id: athleteId,
    channel: 'tg',
    direction: 'out',
    body: text,
  });
}

/**
 * Resume onboarding after a successful Strava OAuth connect (beat A1).
 *
 * Idempotent: A0 seeds onboarding_state with partial.sub_step = 'awaiting_strava';
 * we advance through advanceIfSubstep guarded on that value, so a duplicate Strava
 * callback finds a different sub_step and no-ops. Best-effort — the caller wraps this
 * so a Strava-fetch failure never fails the OAuth callback.
 *
 * Returns true if it resumed onboarding (sent the A1 message), false if the athlete
 * was not mid-onboarding (e.g. an already-onboarded athlete reconnecting Strava), so
 * the caller can fall back to the standard "connected" confirmation.
 */
export async function resumeAfterStrava(athleteId: string): Promise<boolean> {
  // Cheap pre-check before the Strava round-trip; the RPC is the authoritative gate.
  const state = await loadOnboardingState(athleteId);
  if (state.step !== 0 || (state.partial as ProfileConfirmPartial).sub_step !== 'awaiting_strava') {
    return false;
  }

  const { data: athlete } = await supabaseAdmin()
    .from('athletes')
    .select('id, telegram_chat_id')
    .eq('id', athleteId)
    .maybeSingle();
  if (!athlete?.telegram_chat_id) return false;

  // Profile + recent activities (the latter only to derive the timezone). The fitness
  // snapshot is fetched later by training-shape, since partial is wiped between steps.
  const [profile, activities] = await Promise.all([
    getLoggedInAthlete(athleteId).catch(() => null),
    fetchRecentActivities(athleteId, 56, 200).catch(() => []),
  ]);

  const firstname = profile?.firstname ?? null;
  const timezone = deriveTimezone(activities, profile);
  const sex = profile?.sex ?? null;

  // --- v3 handoff: seed the slot state with the Strava-derived identity + cached
  // fitness snapshot and open with the orientation, skipping v2's profile-confirm. ---
  if (isV3Enabled()) {
    const snapshot = await getFitnessSnapshot(athleteId).catch(() => null);
    const v3 = initialV3State(snapshot);
    if (firstname) v3.slots.name = slotValue(firstname, 'inferred', true);
    if (timezone) v3.slots.timezone = slotValue(timezone, 'inferred', true);
    if (sex) v3.slots.sex = slotValue(sex, 'inferred', true);
    // Seed the Strava-inferable training-shape slots as inferred/unconfirmed so
    // Opener 2 states them back for confirmation (W3) rather than asking cold.
    v3.slots = seedStravaInferences(v3.slots, snapshot);

    const won = await seedV3IfAwaitingStrava(athleteId, v3);
    if (!won) return false;

    await sendWithKeyboard(
      athleteId,
      athlete.telegram_chat_id,
      orientationMessage(firstname),
      new InlineKeyboard().text("Let's go", "v3:let's go"),
    );
    return true;
  }

  const hasName = Boolean(firstname);
  const partial: ProfileConfirmPartial = {
    sub_step: hasName ? 'confirm_name' : 'ask_name',
    strava_firstname: firstname,
    strava_timezone: timezone,
    strava_sex: sex,
  };
  const newState: OnboardingState = { step: 0, question: 0, partial };

  // Atomic gate: only the first callback to find 'awaiting_strava' wins and sends.
  const won = await advanceIfSubstep(athleteId, newState, 'awaiting_strava');
  if (!won) return false;

  if (hasName) {
    const label = tzLabel(timezone);
    const where = label ? `, on ${label}` : '';
    await sendWithKeyboard(
      athleteId,
      athlete.telegram_chat_id,
      `Connected and read your last couple months. You're ${firstname}${where}. Is that right?`,
      new InlineKeyboard().text('Yep', 'profile:yep').text('Not quite', 'profile:fix'),
    );
  } else {
    await sendWithKeyboard(
      athleteId,
      athlete.telegram_chat_id,
      'Connected and read your last couple months. What should I call you?',
    );
  }
  return true;
}
