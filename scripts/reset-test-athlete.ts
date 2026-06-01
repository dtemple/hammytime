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

const FRESH_ONBOARDING = { step: 0, partial: {} };

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

  // plan_versions (via the athlete's plan ids), then plans
  const { data: plans } = await db.from('plans').select('id').eq('athlete_id', athlete.id);
  const planIds = (plans ?? []).map((p) => p.id);
  let deletedVersions = 0;
  if (planIds.length > 0) {
    const { count, error } = await db
      .from('plan_versions')
      .delete({ count: 'exact' })
      .in('plan_id', planIds);
    if (error) {
      console.error('Error deleting plan_versions:', error.message);
      process.exit(1);
    }
    deletedVersions = count ?? 0;
  }

  const counts: Record<string, number> = { plan_versions: deletedVersions };

  for (const table of ['plans', 'races', 'injuries', 'memory_files'] as const) {
    const { count, error } = await db
      .from(table)
      .delete({ count: 'exact' })
      .eq('athlete_id', athlete.id);
    if (error) {
      console.error(`Error deleting ${table}:`, error.message);
      process.exit(1);
    }
    counts[table] = count ?? 0;
  }

  // Mark any outstanding link_tokens for this athlete used
  const { count: tokensMarked, error: tokensErr } = await db
    .from('link_tokens')
    .update({ used_at: new Date().toISOString() }, { count: 'exact' })
    .eq('athlete_id', athlete.id)
    .is('used_at', null);
  if (tokensErr) {
    console.error('Error marking link_tokens used:', tokensErr.message);
    process.exit(1);
  }

  // Reset onboarding + check-in state on the athlete row
  const { error: stateErr } = await db
    .from('athletes')
    .update({
      onboarding_state: FRESH_ONBOARDING,
      checkin_state: {},
      updated_at: new Date().toISOString(),
    })
    .eq('id', athlete.id);
  if (stateErr) {
    console.error('Error resetting athlete state:', stateErr.message);
    process.exit(1);
  }

  console.log('Deleted:', counts);
  console.log(`Marked ${tokensMarked ?? 0} link_token(s) used`);
  console.log('Reset onboarding_state to step 0 and cleared checkin_state.');
  console.log('Strava connection, messages, and agent_runs left untouched.');
  console.log('Done. Mint a fresh token to re-onboard: npm run token:mint -- ' + email);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
