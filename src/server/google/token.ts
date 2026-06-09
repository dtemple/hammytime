import { supabaseAdmin } from '@/lib/db';
import { decryptToken, encryptToken } from '@/lib/crypto';
import { refreshAccessToken } from './client';

export type GoogleConnection = {
  accessToken: string;
  calendarId: string | null;
};

/**
 * Loads, validates, and (if needed) refreshes the Google Calendar access token
 * for an athlete. Returns the decrypted access token plus the Daybreak calendar
 * id, or null if the athlete has no connected Google Calendar.
 *
 * Mirrors getAccessToken in src/server/strava/activities.ts, with one
 * deliberate difference: Google refresh responses carry no new refresh_token,
 * so refresh_token_enc is never touched here. Throws GoogleAuthRevokedError
 * (from refreshAccessToken) when the grant has been revoked.
 */
export async function getGoogleAccessToken(athleteId: string): Promise<GoogleConnection | null> {
  const db = supabaseAdmin();
  const { data } = await db
    .from('oauth_tokens')
    .select('access_token_enc, refresh_token_enc, expires_at, provider_calendar_id')
    .eq('athlete_id', athleteId)
    .eq('provider', 'google_calendar')
    .maybeSingle();

  if (!data) return null;

  const expiresAt = new Date(data.expires_at).getTime();
  const nowPlusFiveMin = Date.now() + 5 * 60 * 1000;

  if (expiresAt > nowPlusFiveMin) {
    return {
      accessToken: await decryptToken(data.access_token_enc),
      calendarId: data.provider_calendar_id,
    };
  }

  const refreshToken = await decryptToken(data.refresh_token_enc);
  const refreshed = await refreshAccessToken(refreshToken);

  const newAccessEnc = await encryptToken(refreshed.access_token);
  await db
    .from('oauth_tokens')
    .update({
      access_token_enc: newAccessEnc,
      expires_at: new Date(refreshed.expires_at * 1000).toISOString(),
    })
    .eq('athlete_id', athleteId)
    .eq('provider', 'google_calendar');

  return { accessToken: refreshed.access_token, calendarId: data.provider_calendar_id };
}
