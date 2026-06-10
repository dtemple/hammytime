/**
 * render-system-prompt.ts — print the fully rendered coach system prompt for
 * one athlete, exactly as the worker builds it for a daily run. Zero writes —
 * a review tool for coach.md / system-prompt.ts edits while the eval harness
 * (V3-W5) is deferred.
 *
 * Usage: npx tsx scripts/render-system-prompt.ts <athlete_email>
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { supabaseAdmin } from '../src/lib/db';
import { PlanSchema, type Plan } from '../src/lib/plan-schema';

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npx tsx scripts/render-system-prompt.ts <athlete_email>');
    process.exit(1);
  }

  const db = supabaseAdmin();
  const { data: user } = await db.from('users').select('id').eq('email', email).maybeSingle();
  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }
  const { data: athlete } = await db
    .from('athletes')
    .select('id, name, timezone')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!athlete) {
    console.error(`No athlete row for ${email}`);
    process.exit(1);
  }

  // The worker passes the hydrated folder's parsed plan into renderSystemPrompt
  // (run-agent.ts); mirror that with the current plan version from the DB so
  // {{ease_in_context}} renders the way a real run would see it.
  const { data: planRow } = await db
    .from('plans')
    .select('current_version_id')
    .eq('athlete_id', athlete.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  let plan: Plan | null = null;
  if (planRow?.current_version_id) {
    const { data: version } = await db
      .from('plan_versions')
      .select('plan_json')
      .eq('id', planRow.current_version_id)
      .maybeSingle();
    const parsed = version ? PlanSchema.safeParse(version.plan_json) : null;
    plan = parsed?.success ? parsed.data : null;
  }

  // Late import: the worker module resolves coach.md relative to its own dir.
  const { renderSystemPrompt } = await import('../worker/system-prompt');
  const prompt = await renderSystemPrompt(athlete.id, plan);

  console.error(`# Athlete: ${athlete.name} (${athlete.id}), tz ${athlete.timezone}`);
  console.error(`# Plan: ${plan ? 'current version passed in' : 'none / unparseable'}`);
  console.error('# ---- rendered system prompt below ----\n');
  console.log(prompt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
