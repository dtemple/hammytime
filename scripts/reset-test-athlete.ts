/**
 * reset-test-athlete.ts
 *
 * Resets a TEST athlete back to a pre-onboarding state so onboarding can be
 * re-run from scratch. Clears plans, plan_versions, races, injuries, and
 * memory_files; resets onboarding_state to step 0 and clears checkin_state;
 * marks outstanding link_tokens used. Leaves Strava tokens, messages,
 * agent_runs, and credits alone.
 *
 * This runs against PROD (whatever .env.local points at), so it has a hard
 * guard: it only operates on athletes linked to a GROUP chat (negative
 * telegram_chat_id). The real day-to-day athlete is linked to a private chat
 * (positive id), so this script physically cannot touch it.
 *
 * Usage: npm run test:reset -- <email>
 *
 * After resetting, mint a fresh token (npm run token:mint -- <email>) and paste
 * /start@<bot> <token> into the group for a clean onboarding run.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { supabaseAdmin } from '../src/lib/db';

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run test:reset -- <email>');
    process.exit(1);
  }

  const db = supabaseAdmin();

  const { data: user, error: userErr } = await db
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (userErr) {
    console.error('Error looking up user:', userErr.message);
    process.exit(1);
  }
  if (!user) {
    console.error(`No user found with email: ${email}. Nothing to reset.`);
    process.exit(1);
  }

  const { data: athlete, error: athleteErr } = await db
    .from('athletes')
    .select('id, name, telegram_chat_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (athleteErr) {
    console.error('Error looking up athlete:', athleteErr.message);
    process.exit(1);
  }
  if (!athlete) {
    console.error(`No athlete found for ${email}. Nothing to reset.`);
    process.exit(1);
  }

  // Hard safety guard: only group-linked (negative chat_id) test athletes.
  const chatId = athlete.telegram_chat_id;
  if (!chatId || !chatId.startsWith('-')) {
    console.error(
      `Refusing to reset: athlete ${athlete.name} (${athlete.id}) is linked to chat_id ` +
        `${chatId ?? 'null'}, which is not a group chat. This script only resets ` +
        `test athletes onboarded inside a Telegram group (negative chat_id).`,
    );
    process.exit(1);
  }

  console.log(`Resetting test athlete: ${athlete.name} (${athlete.id}), chat_id ${chatId}`);

  // Same transactional clear-set that /restart uses, so there's one source of
  // truth: plan_versions, plans, races, injuries, memory_files,
  // athlete_training_profile, pending job_queue rows; onboarding/checkin state
  // reset. (Strava, messages, agent_runs preserved.)
  const { error: resetErr } = await db.rpc('reset_athlete_onboarding', {
    p_athlete_id: athlete.id,
  });
  if (resetErr) {
    console.error('Error in reset_athlete_onboarding:', resetErr.message);
    process.exit(1);
  }

  // link_tokens aren't onboarding-derived data, so the RPC leaves them alone —
  // mark any outstanding ones used here so a stale token can't be reused.
  const { count: tokensMarked, error: tokensErr } = await db
    .from('link_tokens')
    .update({ used_at: new Date().toISOString() }, { count: 'exact' })
    .eq('athlete_id', athlete.id)
    .is('used_at', null);
  if (tokensErr) {
    console.error('Error marking link_tokens used:', tokensErr.message);
    process.exit(1);
  }

  console.log('Cleared plans, races, injuries, memory_files, training profile, and pending jobs.');
  console.log(`Marked ${tokensMarked ?? 0} link_token(s) used`);
  console.log('Reset onboarding_state to step 0 and cleared checkin_state.');
  console.log('Strava connection, messages, and agent_runs left untouched.');
  console.log('Done. Mint a fresh token to re-onboard: npm run token:mint -- ' + email);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
