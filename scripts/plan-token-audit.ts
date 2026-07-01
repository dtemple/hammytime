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
//   npx tsx scripts/plan-token-audit.ts --read-mix            # view-vs-full-plan read share + checkin_log sizes, last 14 days
//   npx tsx scripts/plan-token-audit.ts --read-mix 7          # ...over the last 7 days
//   npx tsx scripts/plan-token-audit.ts --read-mix 2026-06-24T23:30:00Z  # ...since a timestamp
//
// The cost modes above are confounded by usage/context growth over calendar time
// (it moves cache_creation the same direction as calendar time), so they can't
// isolate a read-path change. --read-mix measures the change directly instead:
// which plan file runs actually Read, and how big checkin_log.md has grown.

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

const TRACKED_READ_FILES = [
  'plan_view_readonly.json',
  'marathon_training_plan.json',
  'plan_drift.md',
  'checkin_log.md',
  'checkin_log_archive.md',
  'strava_recent.json',
];

type StepRow = {
  agent_run_id: string;
  tool_name: string | null;
  input_json: unknown;
  created_at: string;
};

// PostgREST caps a select at 1000 rows; page through so a busy window doesn't
// silently truncate (the bug that made an ad-hoc read-mix probe report zero).
async function fetchSteps(
  db: ReturnType<typeof supabaseAdmin>,
  tools: string[],
  since: string | null,
): Promise<StepRow[]> {
  const pageSize = 1000;
  const out: StepRow[] = [];
  for (let from = 0; ; from += pageSize) {
    let q = db
      .from('agent_run_steps')
      .select('agent_run_id, tool_name, input_json, created_at')
      .in('tool_name', tools);
    if (since) q = q.gte('created_at', since);
    const { data, error } = await q
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`agent_run_steps read failed: ${error.message}`);
    const page = (data ?? []) as unknown as StepRow[];
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

// Direct measurement of the current-block-view + log-rotation changes: which plan
// file runs actually Read (the small view vs the full plan), and how big
// checkin_log.md has grown. Immune to the cost aggregate's growth confound.
async function readMix(
  db: ReturnType<typeof supabaseAdmin>,
  sinceIso: string,
  label: string,
): Promise<void> {
  const steps = await fetchSteps(db, ['Read'], sinceIso);
  const perRun = new Map<string, Set<string>>();
  for (const s of steps) {
    const fp = (s.input_json as { file_path?: unknown } | null)?.file_path;
    if (typeof fp !== 'string') continue;
    const base = fp.split('/').pop() ?? fp;
    let set = perRun.get(s.agent_run_id);
    if (!set) {
      set = new Set();
      perRun.set(s.agent_run_id, set);
    }
    set.add(base);
  }

  const n = perRun.size;
  console.log(`\nRead-mix — ${label} — ${n} run(s) with a Read (${steps.length} Read steps)`);
  if (n === 0) return;

  const freq: Record<string, number> = {};
  for (const set of perRun.values()) for (const f of set) freq[f] = (freq[f] ?? 0) + 1;

  const pct = (f: string) => (100 * (freq[f] ?? 0)) / n;
  console.log('  share of runs that Read each file:');
  for (const f of TRACKED_READ_FILES) {
    console.log(`    ${`${pct(f).toFixed(0)}%`.padStart(4)}  ${f}`);
  }
  console.log(
    `  => plan read as VIEW ${pct('plan_view_readonly.json').toFixed(0)}% vs ` +
      `FULL plan ${pct('marathon_training_plan.json').toFixed(0)}% ` +
      `(the fix works when view is high and full is low)`,
  );

  const { data: mf, error } = await db
    .from('memory_files')
    .select('file_name, content_md')
    .in('file_name', ['checkin_log.md', 'checkin_log_archive.md']);
  if (error) throw new Error(`memory_files read failed: ${error.message}`);

  const byFile: Record<string, number[]> = {};
  for (const r of mf ?? []) {
    const tokens = Math.round(((r.content_md as string | null)?.length ?? 0) / 4);
    (byFile[r.file_name] ??= []).push(tokens);
  }
  console.log('  checkin_log size across athletes (tokens ≈ chars/4):');
  for (const f of ['checkin_log.md', 'checkin_log_archive.md']) {
    const arr = (byFile[f] ?? []).slice().sort((a, b) => a - b);
    if (arr.length === 0) {
      console.log(`    ${f}: (none yet)`);
      continue;
    }
    console.log(
      `    ${f.padEnd(24)} n=${arr.length}  median ${fmt(quantile(arr, 0.5))}  ` +
        `p90 ${fmt(quantile(arr, 0.9))}  max ${fmt(arr[arr.length - 1] ?? 0)}`,
    );
  }
}

async function main() {
  const db = supabaseAdmin();

  // --read-mix: measure the view/rotation change directly (view vs full-plan read
  // share + checkin_log sizes), sidestepping the cost modes' growth confound.
  // Optional window arg: a trailing-day count (default 14) or an ISO "since".
  if (process.argv[2] === '--read-mix') {
    const w = process.argv[3];
    let sinceIso: string;
    let label: string;
    if (w && !/^\d+$/.test(w)) {
      const d = new Date(w);
      if (Number.isNaN(d.getTime())) throw new Error(`Unrecognized --read-mix window "${w}".`);
      sinceIso = d.toISOString();
      label = `since ${sinceIso}`;
    } else {
      const nd = w ? Number(w) : 14;
      sinceIso = new Date(Date.now() - nd * 86_400_000).toISOString();
      label = `last ${nd} days`;
    }
    await readMix(db, sinceIso, label);
    return;
  }

  // Arg is either a trailing-day count (e.g. "30") or an ISO cutoff timestamp
  // (e.g. "2026-06-08T01:42:00Z") which reports before-vs-after that instant.
  const arg = process.argv[2];
  const days = arg && /^\d+$/.test(arg) ? Number(arg) : null;
  const cutoff = arg && !/^\d+$/.test(arg) ? new Date(arg) : null;
  if (cutoff && Number.isNaN(cutoff.getTime())) {
    throw new Error(`Unrecognized arg "${arg}" — pass a day count or an ISO timestamp.`);
  }

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
  // Paginated so we don't silently miss recent edits past PostgREST's 1000-row cap.
  const steps = await fetchSteps(db, ['Edit', 'Write'], null);

  const editedRunIds = new Set<string>();
  for (const s of steps) {
    const fp = (s.input_json as { file_path?: unknown } | null)?.file_path;
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
