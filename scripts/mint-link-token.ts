/**
 * mint-link-token.ts
 *
 * Mints a `start`-purpose link_token for an email, bypassing the /signup web
 * page. Built for repeated onboarding tests: it prints a ready-to-paste
 * `/start@<bot> <token>` command for the staging group, since Telegram deep
 * links (t.me/bot?start=...) only open private chats, never groups.
 *
 * Runs against whatever .env.local points at — for the staging-bot plan that
 * is the PROD Supabase project.
 *
 * Usage: npm run token:mint -- <email> [ttl_minutes]
 *   ttl_minutes defaults to 60 (signup uses 15; longer is friendlier for testing).
 */

import { randomBytes } from 'crypto';
import { config } from 'dotenv';
config({ path: '.env.local' });

import { supabaseAdmin } from '../src/lib/db';

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const ttlMinutes = Number(process.argv[3] ?? 60);

  if (!email) {
    console.error('Usage: npm run token:mint -- <email> [ttl_minutes]');
    process.exit(1);
  }
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    console.error(`Invalid ttl_minutes: ${process.argv[3]}`);
    process.exit(1);
  }

  const db = supabaseAdmin();

  // The web flow gates on the allowlist; we bypass it here, so warn (don't block)
  // if the email isn't allowlisted — it just means /signup would have rejected it.
  const { data: allow } = await db
    .from('friend_allowlist')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (!allow) {
    console.warn(`Note: ${email} is not on friend_allowlist (the web /signup would reject it).`);
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  const { error } = await db
    .from('link_tokens')
    .insert({ email, token, expires_at: expiresAt, purpose: 'start' });

  if (error) {
    console.error('Failed to mint link token:', error.message);
    process.exit(1);
  }

  const bot = process.env.TELEGRAM_BOT_USERNAME ?? '<staging_bot_username>';

  console.log(`Minted start token for ${email} (expires in ${ttlMinutes} min).`);
  console.log('');
  console.log('Paste this into the staging group:');
  console.log('');
  console.log(`  /start@${bot} ${token}`);
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
