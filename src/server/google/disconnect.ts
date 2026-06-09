import { supabaseAdmin } from '@/lib/db';
import { revokeToken } from './client';
import { deleteCalendar } from './calendar-api';
import { getGoogleAccessToken } from './token';

/**
 * Disconnects Google Calendar for an athlete: deletes the Daybreak calendar
 * on Google's side (total removal — every event goes with it), revokes the
 * grant, and drops the token row. Remote steps are best-effort; the row
 * delete always runs, so a half-failed disconnect still ends disconnected
 * on our side. Mirrors src/server/strava/disconnect.ts.
 */
export async function disconnectGoogleCalendar(athleteId: string): Promise<{
  hadConnection: boolean;
  calendarDeleted: boolean;
}> {
  let calendarDeleted = false;

  try {
    const conn = await getGoogleAccessToken(athleteId);
    if (conn) {
      if (conn.calendarId) {
        await deleteCalendar(conn.accessToken, conn.calendarId);
        calendarDeleted = true;
      }
      await revokeToken(conn.accessToken).catch(() => {});
    }
  } catch {
    // Token already revoked/expired — nothing to clean up remotely. The
    // orphaned calendar (if any) stays; we have no credential to remove it.
  }

  const { data, error } = await supabaseAdmin()
    .from('oauth_tokens')
    .delete()
    .eq('athlete_id', athleteId)
    .eq('provider', 'google_calendar')
    .select('id');

  if (error) throw new Error(`disconnectGoogleCalendar delete failed: ${error.message}`);

  return { hadConnection: (data ?? []).length > 0, calendarDeleted };
}
