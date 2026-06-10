/**
 * dry-run-plan-extend.ts — GF-W1 verification tool.
 *
 * Runs the open-ended plan-extension path (detect → render → merge → validate)
 * for one athlete WITHOUT persisting anything: no plan_versions row, no
 * calendar_sync job. Prints the eligibility/horizon decision and, when an
 * extension would fire, a summary of the merged plan.
 *
 * Usage: npx tsx scripts/dry-run-plan-extend.ts <athlete_email> [--force]
 *
 *   --force  ignore the 14-day horizon gate so the render/merge path can be
 *            exercised on a healthy plan. Still a dry run — nothing is written.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { supabaseAdmin } from '../src/lib/db';
import { PlanSchema } from '../src/lib/plan-schema';
import { futureDatedDayCount, continuationStart, validateSafety } from '../src/lib/plan-templates';
import { DRAFT_SAFETY_CAPS } from '../src/lib/plan-templates/caps';

async function main() {
  const email = process.argv[2];
  const force = process.argv.includes('--force');
  if (!email) {
    console.error('Usage: npx tsx scripts/dry-run-plan-extend.ts <athlete_email> [--force]');
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
  console.log(`Athlete: ${athlete.name} (${athlete.id}), tz ${athlete.timezone}`);

  // Late imports: todayInTz et al. read env at module scope in some deps.
  const { extendPlanIfDue, EXTENSION_HORIZON_DAYS } = await import('../src/server/plan/extend');
  const { todayInTz } = await import('../src/server/telegram/onboarding/plan-gen');
  const { getTrainingProfile } = await import(
    '../src/server/telegram/onboarding/athlete-training-profile'
  );

  const profile = await getTrainingProfile(athlete.id);
  console.log(
    `Profile: goal_state=${profile?.goal_state ?? '(none)'}, goal_distance=${profile?.goal_distance ?? '-'}, goal_race_id=${profile?.goal_race_id ?? 'none'}`,
  );

  // Independent horizon report (the gate extendPlanIfDue applies silently).
  const { data: planRow } = await db
    .from('plans')
    .select('id, current_version_id')
    .eq('athlete_id', athlete.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: version } = planRow?.current_version_id
    ? await db
        .from('plan_versions')
        .select('id, plan_json, status, generated_by')
        .eq('id', planRow.current_version_id)
        .maybeSingle()
    : { data: null };
  if (!planRow || !version) {
    console.log('No working plan — extendPlanIfDue would return null.');
  } else {
    const parsed = PlanSchema.safeParse(version.plan_json);
    if (!parsed.success) {
      console.log(`Current version ${version.id} fails PlanSchema — would be skipped.`);
    } else {
      const today = todayInTz(athlete.timezone ?? 'America/Los_Angeles');
      const remaining = futureDatedDayCount(parsed.data, today);
      const start = continuationStart(parsed.data, today);
      console.log(
        `Working plan: ${parsed.data.weeks.length} weeks, version ${version.id} (${version.generated_by}, ${version.status})`,
      );
      console.log(
        `Horizon: ${remaining} future day(s) as of ${today} (threshold ≤ ${EXTENSION_HORIZON_DAYS}); ` +
          `continuation would start ${start?.startDate} (easeIn=${start?.easeIn})`,
      );
    }
  }

  const result = await extendPlanIfDue(athlete.id, {
    dryRun: true,
    ...(force ? { horizonDays: Number.POSITIVE_INFINITY } : {}),
  });
  if (!result) {
    console.log(
      `\nextendPlanIfDue (dry run${force ? ', --force' : ''}): no extension due. Nothing would be written.`,
    );
    return;
  }

  const merged = result.mergedPlan!;
  console.log(`\nextendPlanIfDue (dry run): WOULD extend +${result.blockWeeks} weeks`);
  console.log(`  merged total weeks: ${merged.weeks.length}`);
  console.log(`  new end date:       ${result.newEndDate}`);
  console.log(`  placeholder race:   ${merged.metadata.race.name} (${merged.metadata.race.date})`);
  const seamA = merged.weeks[merged.weeks.length - result.blockWeeks - 1];
  const seamB = merged.weeks[merged.weeks.length - result.blockWeeks];
  console.log(
    `  seam: w${seamA?.week_number} ${seamA?.planned_total_run_miles}mi (${seamA?.phase}) → ` +
      `w${seamB?.week_number} ${seamB?.planned_total_run_miles}mi (${seamB?.phase}), starts ${seamB?.start_date}`,
  );
  const safety = validateSafety(merged, DRAFT_SAFETY_CAPS, 'keep_fit');
  console.log(
    safety.ok
      ? '  safety: OK'
      : `  safety: ${safety.violations.length} violation(s):\n` +
          safety.violations.map((v) => `    w${v.week} ${v.rule}: ${v.detail}`).join('\n'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
