import { InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import { botApiForChat } from '../bot';
import { fetchRecentActivities, getLoggedInAthlete, deriveTimezone } from '@/server/strava/activities';
import { advanceIfSubstep, loadOnboardingState } from './state';
import type { ProfileConfirmPartial } from './steps/00-profile-confirm';
import type { OnboardingState } from './types';

// "America/Los_Angeles" -> "Los Angeles"; "America/Argentina/Buenos_Aires" -> "Buenos Aires".
function ianaCity(tz: string | null): string | null {
  if (!tz) return null;
  const last = tz.split('/').pop();
  return last ? last.replace(/_/g, ' ') : null;
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
    const city = ianaCity(timezone);
    const where = city ? `, running out of ${city}` : '';
    await sendWithKeyboard(
      athleteId,
      athlete.telegram_chat_id,
      `Connected — read your last couple months. You're ${firstname}${where}. That you?`,
      new InlineKeyboard().text('Yep', 'profile:yep').text('I go by…', 'profile:rename'),
    );
  } else {
    await sendWithKeyboard(
      athleteId,
      athlete.telegram_chat_id,
      "Connected — read your last couple months. What should I call you?",
    );
  }
  return true;
}
