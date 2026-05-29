import { supabaseAdmin } from '@/lib/db';
import { getAccessToken } from './activities';
import { deauthorize } from './client';

/**
 * Single source of truth for severing an athlete's Strava connection.
 *
 * Strava's API terms require us to delete a user's data within 48h of their
 * revoking access. daybreak persists no Strava activity data, so "deletion"
 * is just removing the encrypted `oauth_tokens` row.
 *
 * The deletion always happens. Revoking on Strava's side (`revokeOnStrava`) is
 * best-effort: when the athlete asks us to disconnect (`/disconnect_strava`) we
 * also revoke our app's access on Strava so it disappears from their
 * https://www.strava.com/settings/apps page. When Strava tells *us* the athlete
 * already revoked (the deauth webhook), there's nothing to revoke — pass false.
 *
 * @returns hadConnection — whether a token row existed to delete.
 *          revoked — whether the Strava-side revocation succeeded.
 */
export async function disconnectStrava(
  athleteId: string,
  opts: { revokeOnStrava: boolean },
): Promise<{ hadConnection: boolean; revoked: boolean }> {
  const db = supabaseAdmin();

  // Revoke while the token still exists. Best-effort: a broken or already-revoked
  // token can't be revoked, but we must still delete our copy regardless.
  let revoked = false;
  if (opts.revokeOnStrava) {
    try {
      const accessToken = await getAccessToken(athleteId);
      if (accessToken) {
        await deauthorize(accessToken);
        revoked = true;
      }
    } catch (err) {
      console.warn('[disconnectStrava] revoke-on-strava failed (continuing to delete):', err);
    }
  }

  const { data, error } = await db
    .from('oauth_tokens')
    .delete()
    .eq('athlete_id', athleteId)
    .eq('provider', 'strava')
    .select('id');

  if (error) throw new Error(`Failed to delete Strava token: ${error.message}`);

  return { hadConnection: (data?.length ?? 0) > 0, revoked };
}
