// calendar_sync job — converge the athlete's Google "Daybreak" calendar onto
// the active plan (Specs/CALENDAR_OAUTH.md). The first non-agent job kind:
// pure code, no folder hydrate, no Agent SDK.

import { supabaseAdmin } from '@/lib/db';
import { GoogleAuthRevokedError } from '@/server/google/client';
import { reconcileCalendar } from '@/server/google/sync';
import { sendReply } from '../send';

export async function runCalendarSync(athleteId: string): Promise<void> {
  try {
    const result = await reconcileCalendar(athleteId);
    console.log(
      `[calendar-sync] ${athleteId}: imported=${result.imported} patched=${result.patched} deleted=${result.deleted} skipped=${result.skipped}`,
    );
  } catch (err) {
    if (err instanceof GoogleAuthRevokedError) {
      // The grant is gone — retrying can't succeed. Tear the connection down
      // and point the athlete at the reconnect path. The Daybreak calendar
      // itself can't be deleted here (no valid token); only an athlete-
      // initiated /disconnect_calendar can clean it up on Google's side.
      await supabaseAdmin()
        .from('oauth_tokens')
        .delete()
        .eq('athlete_id', athleteId)
        .eq('provider', 'google_calendar');

      await sendReply(
        athleteId,
        'Your Google Calendar connection expired or was revoked, so your Daybreak calendar has stopped updating. Run /calendar to reconnect — or use the subscribe link there, which works without reconnecting.',
      ).catch(() => {});
      return; // terminal: complete the job, don't retry
    }
    throw err; // anything else → job-queue backoff/retry
  }
}
