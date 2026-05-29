/**
 * Removes the stored Strava OAuth token for an athlete and revokes our app's
 * access on Strava's side.
 *
 * Usage:
 *   npx tsx scripts/disconnect-strava.ts <telegram_chat_id>
 *
 * After running this, the athlete can run /connect_strava in Telegram
 * to reconnect with the correct Strava account.
 *
 * Delegates to disconnectStrava() — the same single source of truth used by the
 * /disconnect_strava bot command and the Strava deauth webhook.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { supabaseAdmin } from '../src/lib/db';
import { disconnectStrava } from '../src/server/strava/disconnect';

async function main() {
  const telegramChatId = process.argv[2];
  if (!telegramChatId) {
    console.error('Usage: npx tsx scripts/disconnect-strava.ts <telegram_chat_id>');
    process.exit(1);
  }

  const db = supabaseAdmin();

  const { data: athlete, error: athleteErr } = await db
    .from('athletes')
    .select('id, telegram_chat_id')
    .eq('telegram_chat_id', telegramChatId)
    .maybeSingle();

  if (athleteErr || !athlete) {
    console.error('No athlete found for telegram_chat_id:', telegramChatId);
    process.exit(1);
  }

  const { hadConnection, revoked } = await disconnectStrava(athlete.id, { revokeOnStrava: true });

  if (!hadConnection) {
    console.log('No Strava token on file for this athlete — nothing to remove.');
    process.exit(0);
  }

  console.log(`Token removed for athlete ${athlete.id}.`);
  console.log(
    revoked
      ? 'Access revoked on Strava — the quota slot is freed.'
      : 'Could not revoke on Strava (token already broken/expired). If the slot is still ' +
          'held, revoke manually at https://www.strava.com/settings/apps.',
  );
  console.log('The athlete can now run /connect_strava to reconnect.');
}

main();
