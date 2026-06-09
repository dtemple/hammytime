// Proactive post-activity coaching trigger (SPEC §3.5.1).
//
// When an athlete finishes a workout and it lands on Strava, the app-level push
// subscription delivers an `activity`/`create` event to /api/strava/webhook. We
// enqueue a `tg_message` job flagged `trigger: 'post_activity'` and carrying the
// triggering activity id, so the worker runs its dedicated post-activity prompt
// (acknowledge the specific activity, judge its impact on the week, ask before
// any plan change) instead of the generic /fresh_update rundown. The worker's
// hydrate() already wipes the folder, re-fetches Strava, and reloads memory on
// every run, so the new activity is the newest entry in strava_recent.json by
// the time the agent reads it — no schema or job-kind change. A `text` seed
// rides along as a fallback for a worker that predates the post-activity layer.
//
// Two guards keep this from spamming (and from drawing down agent_runs/credits):
//   - per-activity dedup via the job key `tg_strava:<athlete>:<objectId>` (a
//     repeated delivery of the same event is an enqueue no-op), and
//   - a per-athlete cooldown that stands down only on a recent *post-activity*
//     push (another `tg_strava:<athlete>:…` job). It deliberately ignores the
//     daily and the athlete's own chat/commands: the post-activity push should
//     fire even right after the morning note. Its only job is to swallow a burst
//     of activities uploaded at once (a watch syncing a backlog).

import { supabaseAdmin } from '@/lib/db';
import { enqueueJob } from '@/server/jobs/enqueue';
import { isOnboarded } from '@/server/telegram/onboarding';

/**
 * How recently another post-activity push must have fired for this one to stand
 * down. Sized to catch a backlog-sync burst (those upload seconds apart) while
 * letting a genuine double-day — an AM and a PM run an hour-plus apart — each get
 * their own message.
 */
export const POST_ACTIVITY_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Fallback seed only. An up-to-date worker branches on `trigger: 'post_activity'`
 * and runs its dedicated post-activity prompt, never reading this. A worker that
 * predates that layer ignores the flag and runs this text as a generic
 * /fresh_update rundown — degraded, but still a useful message.
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

  // Onboarding must be complete (the daily cron uses the same predicate). Both
  // flows: v3 stores { flow:'v3', phase } with no `step`, so a step-only check
  // would silently skip every v3 athlete.
  if (
    !isOnboarded(
      athlete.onboarding_state as { flow?: string; phase?: string; step?: number } | null,
    )
  ) {
    return;
  }

  // Cooldown: stand down only if another post-activity push fired recently. The
  // key prefix `tg_strava:<athlete>:` scopes this to our own pushes — the daily,
  // /fresh_update, and ordinary chat (other tg_message keys) don't suppress it,
  // so the push still fires right after the morning note. The athlete uuid has no
  // LIKE wildcard chars and the pattern is colon-bounded, so it can't match
  // another athlete or job kind.
  const since = new Date(Date.now() - POST_ACTIVITY_COOLDOWN_MS).toISOString();
  const { data: recent } = await db
    .from('job_queue')
    .select('id')
    .eq('kind', 'tg_message')
    .like('key_unique', `tg_strava:${athleteId}:%`)
    .gte('created_at', since)
    .limit(1)
    .maybeSingle();
  if (recent) return;

  await enqueueJob('tg_message', `tg_strava:${athleteId}:${objectId}`, {
    athlete_id: athleteId,
    trigger: 'post_activity',
    strava_activity_id: objectId,
    text: POST_ACTIVITY_SEED, // fallback for a worker that predates the post-activity layer
  });
}
