/**
 * regen-template-plans.ts
 *
 * One-time regeneration of existing committed-race athletes' persisted plans to
 * bring them in line with the T-1 race-day fix (commit 856822e). The renderer
 * now lands exactly one type:'race' day on the real race date with the last week
 * anchored to the race week, but generateAndPersistPlan reuses an athlete's
 * existing active plan, so already-generated plans don't self-heal. This script
 * detects committed-race plans whose LIVE plan_json fails the race-day invariant
 * and re-renders the untouched template ones in place. Coach-edited plans
 * (current_version_id != baseline_version_id) are flagged for manual review,
 * never overwritten.
 *
 * Decisions (David): silent (no Telegram); proven-wrong only; re-anchor to today
 * per athlete tz; flag-and-skip coach edits.
 *
 * Dry-run by default. Writes only under --apply. .env.local points at PROD, so
 * this touches live athlete data — dry-run and review before applying.
 *
 * Usage:
 *   npx tsx scripts/regen-template-plans.ts            # dry-run (default)
 *   npx tsx scripts/regen-template-plans.ts --apply    # write the fixes
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { supabaseAdmin } from '../src/lib/db';
import {
  buildSelectorProfile,
  toFitnessSnapshotInput,
  todayInTz,
} from '../src/server/telegram/onboarding/plan-gen';
import { getFitnessSnapshot } from '../src/server/strava/activities';
import {
  selectPlan,
  renderPlan,
  assertRaceDayInvariant,
  DRAFT_SAFETY_CAPS,
} from '../src/lib/plan-templates';
import { PlanSchema, type Plan } from '../src/lib/plan-schema';

const BACKUP_DIR = '/tmp/hammytime-regen-backups';

type Verdict = 'CLEAN' | 'AUTO-FIX' | 'FLAG' | 'SKIP';

/** Race-day dates in a plan's rendered week grid (the thing T-1 fixed). */
function raceDays(plan: Plan): string[] {
  return plan.weeks
    .flatMap((w) => w.days)
    .filter((d) => d.type === 'race')
    .map((d) => d.date ?? 'undated');
}

/** Plan span as first→last day, preferring plan_structure, falling back to weeks. */
function span(plan: Plan): string {
  const ps = plan.metadata.plan_structure;
  const start = ps.start_date ?? plan.weeks[0]?.start_date ?? '?';
  const end = ps.end_date ?? plan.weeks[plan.weeks.length - 1]?.end_date ?? '?';
  return `${start} → ${end}`;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const db = supabaseAdmin();

  console.log(
    `\n=== regen-template-plans (${apply ? 'APPLY — writing fixes' : 'DRY RUN — no writes'}) ===\n`,
  );

  // 1. Enumerate committed-race candidates.
  const { data: profiles, error: profErr } = await db
    .from('athlete_training_profile')
    .select('athlete_id')
    .eq('goal_state', 'committed')
    .not('goal_race_id', 'is', null);
  if (profErr) {
    console.error('Error fetching training profiles:', profErr.message);
    process.exit(1);
  }
  const athleteIds = (profiles ?? []).map((p) => p.athlete_id);
  console.log(`Committed-race candidates: ${athleteIds.length}\n`);

  let cleanCount = 0;
  let fixedCount = 0;
  const flagged: string[] = [];
  const skipped: string[] = [];

  for (const athleteId of athleteIds) {
    const { data: athlete } = await db
      .from('athletes')
      .select('id, name, timezone')
      .eq('id', athleteId)
      .maybeSingle();
    const name = athlete?.name ?? '(unknown)';
    const label = `${name} [${athleteId}]`;

    // Latest plan row.
    const { data: planRow } = await db
      .from('plans')
      .select('id, current_version_id, baseline_version_id, start_date, weeks')
      .eq('athlete_id', athleteId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!planRow?.current_version_id) {
      console.log(`SKIP   ${label} — no active plan`);
      skipped.push(athleteId);
      continue;
    }

    // Live (current) version — what the worker / calendar / web actually serve.
    const { data: liveVersion } = await db
      .from('plan_versions')
      .select('id, plan_json, generated_by, status')
      .eq('id', planRow.current_version_id)
      .maybeSingle();
    const parsed = liveVersion?.plan_json
      ? PlanSchema.safeParse(liveVersion.plan_json)
      : null;
    if (!parsed || !parsed.success) {
      console.log(`SKIP   ${label} — live version missing or unparseable`);
      skipped.push(athleteId);
      continue;
    }
    const livePlan = parsed.data;

    // Rebuild params exactly as onboarding does, anchored to today.
    const today = todayInTz(athlete?.timezone ?? 'America/Los_Angeles');
    const profile = await buildSelectorProfile(athleteId, today);
    const snapshot = toFitnessSnapshotInput(await getFitnessSnapshot(athleteId));
    const { template, params } = selectPlan(profile, snapshot, DRAFT_SAFETY_CAPS);

    if (params.race == null) {
      console.log(
        `SKIP   ${label} — committed but selector produced no race (data anomaly: check races row)`,
      );
      skipped.push(athleteId);
      continue;
    }

    // Detect: does the live plan satisfy the race-day invariant against the real race date?
    let affected = false;
    try {
      assertRaceDayInvariant(livePlan, params);
    } catch {
      affected = true;
    }

    const untouched = planRow.current_version_id === planRow.baseline_version_id;
    const oldRace = raceDays(livePlan).join(', ') || 'none';
    const oldSpan = span(livePlan);

    if (!affected) {
      console.log(
        `CLEAN  ${label} — race day ${oldRace} == ${params.race.date}, span ${oldSpan}`,
      );
      cleanCount++;
      continue;
    }

    // Affected. Classify.
    let verdict: Verdict;
    if (untouched && liveVersion?.generated_by === 'template') {
      verdict = 'AUTO-FIX';
    } else {
      verdict = 'FLAG';
    }

    // Re-render fresh for the diff (and the write, if AUTO-FIX). renderPlan
    // self-validates via assertRaceDayInvariant and throws rather than emit a bad plan.
    let fresh: Plan;
    try {
      fresh = renderPlan(template, params);
      assertRaceDayInvariant(fresh, params); // belt-and-suspenders
    } catch (err) {
      console.log(
        `SKIP   ${label} — fresh render failed validation: ${(err as Error).message}`,
      );
      skipped.push(athleteId);
      continue;
    }

    const newRace = raceDays(fresh).join(', ');
    const newSpan = span(fresh);
    console.log(
      [
        `${verdict} ${label}`,
        `       generated_by=${liveVersion?.generated_by} current==baseline=${untouched}`,
        `       race:  ${oldRace}  →  ${newRace}   (real race ${params.race.date})`,
        `       span:  ${oldSpan}  →  ${newSpan}`,
        `       weeks: ${livePlan.weeks.length}  →  ${fresh.weeks.length}`,
      ].join('\n'),
    );

    if (verdict === 'FLAG') {
      console.log(`       ↳ coach-edited — flagged for manual review, NOT modified`);
      flagged.push(athleteId);
      continue;
    }

    // AUTO-FIX.
    if (!apply) {
      console.log(`       ↳ would fix (re-run with --apply)`);
      fixedCount++;
      continue;
    }

    // Back up the old plan_json before the unrecoverable in-place UPDATE.
    mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(
      BACKUP_DIR,
      `${athleteId}-${planRow.current_version_id}-${today}.json`,
    );
    writeFileSync(backupPath, JSON.stringify(livePlan, null, 2), 'utf8');

    const { error: vErr } = await db
      .from('plan_versions')
      .update({ plan_json: fresh })
      .eq('id', planRow.current_version_id);
    if (vErr) {
      console.error(`       ↳ ERROR updating plan_versions: ${vErr.message}`);
      process.exit(1);
    }
    const { error: pErr } = await db
      .from('plans')
      .update({
        start_date: fresh.metadata.plan_structure.start_date,
        weeks: fresh.weeks.length,
        updated_at: new Date().toISOString(),
      })
      .eq('id', planRow.id);
    if (pErr) {
      console.error(`       ↳ ERROR updating plans: ${pErr.message}`);
      process.exit(1);
    }
    console.log(`       ↳ FIXED (backup: ${backupPath})`);
    fixedCount++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  clean:   ${cleanCount}`);
  console.log(`  ${apply ? 'fixed' : 'to fix'}:  ${fixedCount}`);
  console.log(`  flagged: ${flagged.length}${flagged.length ? ` → ${flagged.join(', ')}` : ''}`);
  console.log(`  skipped: ${skipped.length}${skipped.length ? ` → ${skipped.join(', ')}` : ''}`);
  if (!apply && fixedCount > 0) {
    console.log(`\nRe-run with --apply to write the ${fixedCount} fix(es).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
