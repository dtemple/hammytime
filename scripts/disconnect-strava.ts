/**
 * Removes the stored Strava OAuth token for an athlete.
 *
 * Usage:
 *   npx tsx scripts/disconnect-strava.ts <telegram_chat_id>
 *
 * After running this, the athlete can run /connect_strava in Telegram
 * to reconnect with the correct Strava account.
 *
 * NOTE: This only removes the token from the hammytime DB. To free up the
 * Strava API quota slot, also revoke app access from the wrong Strava account:
 *   https://www.strava.com/settings/apps → find hammytime → Revoke Access
 */

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

async function main() {
  const telegramChatId = process.argv[2];
  if (!telegramChatId) {
    console.error("Usage: npx tsx scripts/disconnect-strava.ts <telegram_chat_id>");
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  const db = createClient(supabaseUrl, supabaseServiceKey);

  const { data: athlete, error: athleteErr } = await db
    .from("athletes")
    .select("id, telegram_chat_id")
    .eq("telegram_chat_id", telegramChatId)
    .maybeSingle();

  if (athleteErr || !athlete) {
    console.error("No athlete found for telegram_chat_id:", telegramChatId);
    process.exit(1);
  }

  const { data: token, error: tokenErr } = await db
    .from("oauth_tokens")
    .select("id, provider_athlete_id, expires_at")
    .eq("athlete_id", athlete.id)
    .eq("provider", "strava")
    .maybeSingle();

  if (tokenErr || !token) {
    console.log("No Strava token on file for this athlete — nothing to remove.");
    process.exit(0);
  }

  console.log(`Found Strava token:`);
  console.log(`  Internal athlete ID : ${athlete.id}`);
  console.log(`  Strava athlete ID   : ${token.provider_athlete_id}`);
  console.log(`  Token expires       : ${token.expires_at}`);
  console.log();

  const { error: deleteErr } = await db
    .from("oauth_tokens")
    .delete()
    .eq("id", token.id);

  if (deleteErr) {
    console.error("Delete failed:", deleteErr.message);
    process.exit(1);
  }

  console.log("Token removed. The athlete can now run /connect_strava to reconnect.");
  console.log();
  console.log("To free the Strava quota slot, also revoke access from the wrong account:");
  console.log("  https://www.strava.com/settings/apps → find your app → Revoke Access");
}

main();
