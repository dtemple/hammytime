// Read-only token/cost audit for coaching runs.
//
// Segments agent_runs into "plan-editing" vs "non-editing" and prints the token
// and cost distribution for each. A run is plan-editing if any of its steps was
// an Edit/Write tool call against marathon_training_plan.json (agent_run_steps).
//
// Purpose: quantify the two cost centers before committing to the bigger lever —
// recurring daily *input* (-> per-week files) vs structural-edit *output*
// (-> a plan-patch tool). Also serves as a before/after baseline for the
// compact-serializer change (compare median input_tokens across a deploy).
//
//   npx tsx scripts/plan-token-audit.ts                       # all runs
//   npx tsx scripts/plan-token-audit.ts 30                    # runs from the last 30 days
//   npx tsx scripts/plan-token-audit.ts 2026-06-08T01:42:00Z  # before vs after a cutoff (A/B a deploy)

import { config } from 'dotenv';
config({ path: '.env.local' });
import { supabaseAdmin } from '../src/lib/db';

const PLAN_FILE = 'marathon_training_plan.json';

type Run = {
  id: string;
  kind: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cost_usd: number | null;
  started_at: string;
};

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? 0;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (pos - lo);
}

function stat(runs: Run[], pick: (r: Run) => number | null) {
  const vals = runs.map(pick).map((v) => v ?? 0);
  const sorted = [...vals].sort((a, b) => a - b);
  return { median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) };
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function report(label: string, runs: Run[]) {
  console.log(`\n${label} — ${runs.length} run(s)`);
  if (runs.length === 0) return;
  const rows: [string, (r: Run) => number | null][] = [
    ['input_tokens', (r) => r.input_tokens],
    ['output_tokens', (r) => r.output_tokens],
    ['cache_read_input_tokens', (r) => r.cache_read_input_tokens],
    ['cache_creation_input_tokens', (r) => r.cache_creation_input_tokens],
  ];
  for (const [name, pick] of rows) {
    const s = stat(runs, pick);
    console.log(`  ${name.padEnd(30)} median ${fmt(s.median).padStart(10)}   p90 ${fmt(s.p90).padStart(10)}`);
  }
  const cost = stat(runs, (r) => r.cost_usd);
  console.log(
    `  ${'cost_usd'.padEnd(30)} median ${cost.median.toFixed(4).padStart(10)}   p90 ${cost.p90.toFixed(4).padStart(10)}`,
  );
}

async function main() {
  // Arg is either a trailing-day count (e.g. "30") or an ISO cutoff timestamp
  // (e.g. "2026-06-08T01:42:00Z") which reports before-vs-after that instant.
  const arg = process.argv[2];
  const days = arg && /^\d+$/.test(arg) ? Number(arg) : null;
  const cutoff = arg && !/^\d+$/.test(arg) ? new Date(arg) : null;
  if (cutoff && Number.isNaN(cutoff.getTime())) {
    throw new Error(`Unrecognized arg "${arg}" — pass a day count or an ISO timestamp.`);
  }
  const db = supabaseAdmin();

  let runQuery = db
    .from('agent_runs')
    .select(
      'id, kind, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd, started_at',
    );
  if (days && Number.isFinite(days)) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    runQuery = runQuery.gte('started_at', since);
  }
  const { data: runs, error } = await runQuery;
  if (error) throw new Error(`agent_runs read failed: ${error.message}`);
  if (!runs || runs.length === 0) {
    console.log('No agent_runs found for the window.');
    return;
  }

  // Which runs edited the plan? Pull Edit/Write steps and check the file path.
  const { data: steps, error: stepErr } = await db
    .from('agent_run_steps')
    .select('agent_run_id, tool_name, input_json')
    .in('tool_name', ['Edit', 'Write']);
  if (stepErr) throw new Error(`agent_run_steps read failed: ${stepErr.message}`);

  const editedRunIds = new Set<string>();
  for (const s of steps ?? []) {
    const fp = (s.input_json as Record<string, unknown> | null)?.file_path;
    if (typeof fp === 'string' && fp.includes(PLAN_FILE)) editedRunIds.add(s.agent_run_id);
  }

  const editing = runs.filter((r) => editedRunIds.has(r.id));
  const nonEditing = runs.filter((r) => !editedRunIds.has(r.id));

  console.log(`Window: ${days ? `last ${days} days` : 'all time'}`);
  console.log(`Total runs: ${runs.length}  |  plan-editing: ${editing.length}  |  non-editing: ${nonEditing.length}`);

  if (cutoff) {
    const iso = cutoff.toISOString();
    const before = (rs: Run[]) => rs.filter((r) => r.started_at < iso);
    const after = (rs: Run[]) => rs.filter((r) => r.started_at >= iso);
    console.log(`\nSplitting before/after cutoff ${iso}`);
    report('Non-editing — BEFORE cutoff', before(nonEditing));
    report('Non-editing — AFTER cutoff', after(nonEditing));
    report('Plan-editing — BEFORE cutoff', before(editing));
    report('Plan-editing — AFTER cutoff', after(editing));
    return;
  }

  report('Non-editing runs (recurring daily/adhoc input)', nonEditing);
  report('Plan-editing runs (structural-edit output)', editing);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
