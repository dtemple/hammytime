import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/db';
import { enqueueJob } from '@/server/jobs/enqueue';

// Why each sync was requested — lands in the job payload for log forensics.
export type CalendarSyncReason =
  | 'connect'
  | 'promotion'
  | 'plan_gen'
  | 'strength_zero'
  | 'nightly';

/**
 * Enqueues a calendar_sync job if (and only if) the athlete has a Google
 * Calendar connection. Cheap existence check first — for the common
 * not-connected athlete this is one indexed select and nothing else.
 *
 * Best-effort by design: callers are plan-changing paths (promotion,
 * onboarding plan-gen) that must never fail because the calendar enqueue
 * hiccuped. The nightly reconcile sweeps up anything missed.
 *
 * Call this anywhere the active plan's rendered content changes. Today that's
 * promote_proposed_version, persistTemplatePlan, and setPlanStrengthToZero;
 * the dormant accept_plan_paste RPC also moves current_version_id and needs
 * this trigger if it's ever revived.
 */
export async function enqueueCalendarSyncIfConnected(
  athleteId: string,
  reason: CalendarSyncReason,
  versionId?: string,
): Promise<void> {
  try {
    const { data } = await supabaseAdmin()
      .from('oauth_tokens')
      .select('id')
      .eq('athlete_id', athleteId)
      .eq('provider', 'google_calendar')
      .maybeSingle();
    if (!data) return;

    await enqueueJob('calendar_sync', `calsync-${athleteId}-${versionId ?? reason}-${Date.now()}`, {
      athlete_id: athleteId,
      reason,
    });
  } catch (err) {
    Sentry.captureException(err);
    console.error(`[calendar-sync] enqueue failed for ${athleteId} (${reason}):`, err);
  }
}
