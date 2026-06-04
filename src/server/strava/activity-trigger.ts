// Proactive post-activity coaching trigger (SPEC §3.5.1).
//
// When an athlete finishes a workout and it lands on Strava, the app-level push
// subscription delivers an `activity`/`create` event to /api/strava/webhook. We
// turn that into the same coaching run the athlete gets from /fresh_update: a
// `tg_message` job whose seed asks for a fresh rundown. The worker's hydrate()
// already wipes the folder, re-fetches Strava, and reloads memory on every run,
// so "pull my latest data" comes for free — no worker, schema, or job-kind change.
//
// Two guards keep this from spamming (and from drawing down agent_runs/credits):
//   - per-activity dedup via the job key `tg_strava:<athlete>:<objectId>` (a
//     repeated delivery of the same event is an enqueue no-op), and
//   - a per-athlete cooldown: skip if any coaching run (daily or ad-hoc) was
//     enqueued in the last few hours. This also makes the post-activity send
//     defer to the morning daily — see POST_ACTIVITY_COOLDOWN_MS.

import { supabaseAdmin } from '@/lib/db';
import { enqueueJob } from '@/server/jobs/enqueue';
import { onboardingSteps } from '@/server/telegram/onboarding';

/**
 * How recently a coaching run must have been enqueued for the post-activity send
 * to stand down. Wide enough to (a) collapse a watch backlog-sync into one
 * message and (b) suppress a post-activity send right after the 6:30 daily.
 * An evening run after a morning run still gets its own message (>3h gap).
 */
export const POST_ACTIVITY_COOLDOWN_MS = 3 * 60 * 60 * 1000;

/**
 * The same intent as the /fresh_update command, anchored to the just-logged
 * activity. The worker reads the new activity from the freshly re-fetched
 * strava_recent.json — this seed only tells the agent what kind of turn it is.
 */
const POST_ACTIVITY_SEED =
  'I just logged an activity on Strava. Give me a fresh update — pull my latest ' +
  "data and tell me how it fits my training and what's coming up. You don't need " +
  'to ask me anything right now, just give me the rundown.';

/**
 * Resolve a Strava activity-create event to an athlete and enqueue a coaching
 * run, subject to the onboarded/non-test guards and the cooldown.
 *
 * Best-effort throughout: the webhook swallows any throw to Sentry and always
 * returns 200, so a transient DB error here just means no message (Strava does
 * not retry, since we 200). Every "not eligible" path returns silently.
 */
export async function handleActivityCreate(
  providerAthleteId: string,
  objectId: number,
): Promise<void> {
  const db = supabaseAdmin();

  // Strava athlete id -> our athlete.
  const { data: token } = await db
    .from('oauth_tokens')
    .select('athlete_id')
    .eq('provider', 'strava')
    .eq('provider_athlete_id', providerAthleteId)
    .maybeSingle();
  if (!token) return; // Not one of our athletes.

  const athleteId = token.athlete_id as string;

  const { data: athlete } = await db
    .from('athletes')
    .select('id, telegram_chat_id, onboarding_state')
    .eq('id', athleteId)
    .maybeSingle();
  if (!athlete) return;

  // No chat to message, or a test athlete onboarding in a group (negative
  // chat_id) — the worker sends as the real bot, which isn't in the group.
  const chatId = athlete.telegram_chat_id;
  if (!chatId || String(chatId).startsWith('-')) return;

  // Onboarding must be complete (the daily cron uses the same check).
  const step = (athlete.onboarding_state as { step?: number } | null)?.step ?? 0;
  if (step < onboardingSteps.length) return;

  // Cooldown: stand down if we already engaged recently. Completed-inclusive
  // (a recently-finished daily should still suppress), scoped to the athlete via
  // the uuid embedded in key_unique — same shape as bot.ts hasInFlightCoachingRun.
  const since = new Date(Date.now() - POST_ACTIVITY_COOLDOWN_MS).toISOString();
  const { data: recent } = await db
    .from('job_queue')
    .select('id')
    .in('kind', ['daily_checkin', 'tg_message'])
    .like('key_unique', `%${athleteId}%`)
    .gte('created_at', since)
    .limit(1)
    .maybeSingle();
  if (recent) return;

  await enqueueJob('tg_message', `tg_strava:${athleteId}:${objectId}`, {
    athlete_id: athleteId,
    text: POST_ACTIVITY_SEED,
  });
}
