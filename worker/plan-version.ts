// Persisting coach plan edits as a new working version.
//
// The coach edits marathon_training_plan.json in its folder during a run. If the
// file changed and still validates against PlanSchema, we append it as a new
// active plan_versions row (generated_by='coach_agent') and repoint
// plans.current_version_id — which is what the calendar feed renders. The
// original baseline_version_id is left untouched, so plan_drift.md keeps
// measuring against the original plan of record.
//
// We gate on schema-validity only — the same check the calendar route makes —
// not the advisory coaching caps (SPEC §17), which are warn-not-refuse in
// conversation. A schema-invalid edit is dropped; the last good version stays
// active so the calendar never renders a broken plan.

import { readFile } from 'fs/promises';
import path from 'path';
import { supabaseAdmin } from '@/lib/db';
import type { Json } from '@/lib/db-types';
import { PlanSchema } from '@/lib/plan-schema';
import { hash, type HydratedFolder } from './folder';

// The result of trying to publish a coach plan edit. A `dropped_*` outcome
// carries a short, already-formatted `detail` for the David alert in run-agent —
// the raw Zod error never leaves this module.
export type PlanEditOutcome = {
  outcome: 'no_plan' | 'unchanged' | 'published' | 'dropped_invalid_json' | 'dropped_schema';
  detail?: string;
};

export async function persistPlanEdit(
  athleteId: string,
  folder: HydratedFolder,
): Promise<PlanEditOutcome> {
  if (folder.planHash === undefined) return { outcome: 'no_plan' }; // no plan at hydrate

  let raw: string;
  try {
    raw = await readFile(path.join(folder.dir, 'marathon_training_plan.json'), 'utf8');
  } catch {
    return { outcome: 'no_plan' }; // file gone — nothing to persist
  }

  if (hash(raw) === folder.planHash) return { outcome: 'unchanged' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(
      `[plan-version] athlete ${athleteId}: edited plan is not valid JSON, dropping`,
      e,
    );
    return { outcome: 'dropped_invalid_json', detail: e instanceof Error ? e.message : String(e) };
  }

  const result = PlanSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 5);
    console.error(
      `[plan-version] athlete ${athleteId}: edited plan failed schema validation, dropping ` +
        `(calendar keeps the last good version):`,
      issues,
    );
    const detail = issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    return { outcome: 'dropped_schema', detail };
  }
  const plan = result.data;

  const db = supabaseAdmin();
  const { data: planRow } = await db
    .from('plans')
    .select('id, current_version_id')
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!planRow?.id) {
    console.warn(`[plan-version] athlete ${athleteId}: no plan row to attach the edit to`);
    return { outcome: 'no_plan' };
  }

  const { error } = await db.rpc('record_plan_edit', {
    p_plan_id: planRow.id,
    p_plan_json: plan as unknown as Json,
    p_supersedes_version_id: planRow.current_version_id,
    p_total_weeks: plan.weeks.length,
    p_start_date: plan.metadata.plan_structure.start_date,
  });

  if (error) {
    console.error(`[plan-version] athlete ${athleteId}: record_plan_edit failed: ${error.message}`);
    return { outcome: 'no_plan' };
  }
  console.log(
    `[plan-version] athlete ${athleteId}: published a new working plan version (${plan.weeks.length}w)`,
  );
  return { outcome: 'published' };
}
