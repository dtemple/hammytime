// Per-athlete working-directory lifecycle (M1 plan §3.3, §4).
//
// memory_files (rows of athlete_id, file_name, content_md) is the source of
// truth for the agent's markdown files. For each run we hydrate those rows to
// disk, let the agent read/write real files, then sync changed/new files back.
// Three derived files are also written for the agent to read but are skipped by
// the memory_files sync-back: the pre-fetched Strava context, a drift summary,
// and the working training plan. The plan is the one the agent may edit — a
// changed, valid plan is persisted as a new plan_versions row (plan-version.ts),
// not a memory_files row.

import { createHash } from 'crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabaseAdmin } from '@/lib/db';
import { computeDrift, renderDriftSummary, type PlanDrift } from '@/lib/plan-drift';
import { PlanSchema } from '@/lib/plan-schema';
import { ATHLETE_ROOT, STRAVA_LOOKBACK_DAYS } from './config';
import { buildStravaContext } from './strava';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Files the worker writes as agent input — excluded from the memory_files
// sync-back. strava_recent.json and plan_drift.md are read-only derived input.
// marathon_training_plan.json is the coach's working plan: it IS persisted on a
// change, but as a new plan_versions row (see plan-version.ts), not a
// memory_files row — so it's skipped here too.
export const INPUT_ONLY_FILES = new Set([
  'strava_recent.json',
  'marathon_training_plan.json',
  'plan_drift.md',
  // Static read-only exercise corpus copied in at hydrate — never per-athlete
  // data, so it must never be written back to memory_files.
  'exercises.md',
]);

// The corpus source, resolved relative to this module so the path is correct
// regardless of cwd. Ships in the worker image (Dockerfile `COPY worker`).
const CORPUS_SRC = fileURLToPath(new URL('knowledge/exercises.md', import.meta.url));

export type HydratedFolder = {
  dir: string;
  // file_name -> sha256 of the content written at hydrate time. Used by
  // syncBack to detect which files the agent actually changed.
  memoryHashes: Record<string, string>;
  // sha256 of marathon_training_plan.json at hydrate time, if the athlete has a
  // plan. persistPlanEdit compares against this to detect a coach edit. Absent
  // when the athlete has no active plan.
  planHash?: string;
};

export function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function athleteDir(athleteId: string): string {
  if (!UUID_RE.test(athleteId)) {
    throw new Error(`hydrate: refusing non-uuid athlete id ${JSON.stringify(athleteId)}`);
  }
  return path.join(ATHLETE_ROOT, athleteId);
}

/**
 * Creates the athlete folder, writes every memory_files row plus the
 * input-only Strava context and active training plan, and returns the dir
 * with per-memory-file content hashes for change detection.
 */
export async function hydrate(athleteId: string): Promise<HydratedFolder> {
  const dir = athleteDir(athleteId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const db = supabaseAdmin();
  const memoryHashes: Record<string, string> = {};

  const { data: files, error } = await db
    .from('memory_files')
    .select('file_name, content_md')
    .eq('athlete_id', athleteId);
  if (error) throw new Error(`hydrate: memory_files read failed: ${error.message}`);

  for (const row of files ?? []) {
    const content = row.content_md ?? '';
    await writeFile(path.join(dir, row.file_name), content, 'utf8');
    memoryHashes[row.file_name] = hash(content);
  }

  // The working training plan the coach edits, written as JSON if one exists.
  // We record its hash so persistPlanEdit can tell whether the agent changed it.
  const refs = await loadPlanRefs(athleteId);
  let planHash: string | undefined;
  if (refs?.currentJson != null) {
    const planText = JSON.stringify(refs.currentJson, null, 2);
    await writeFile(path.join(dir, 'marathon_training_plan.json'), planText, 'utf8');
    planHash = hash(planText);
  }

  // Drift summary (read-only input) — how far the working plan has moved from
  // the original baseline. The coach reads this and raises material drift.
  await writeFile(path.join(dir, 'plan_drift.md'), buildDriftMarkdown(refs), 'utf8');

  // Pre-fetched Strava context (input). The coach reads this instead of
  // spawning a fetch — see isolation.ts for why Bash stays denied.
  const strava = await buildStravaContext(athleteId, STRAVA_LOOKBACK_DAYS);
  await writeFile(path.join(dir, 'strava_recent.json'), JSON.stringify(strava, null, 2), 'utf8');

  // Static read-only exercise corpus (input). Grounds the coach's exercise
  // advice in vetted cues + canonical source links. Excluded from syncBack.
  await copyFile(CORPUS_SRC, path.join(dir, 'exercises.md'));

  return { dir, memoryHashes, planHash };
}

/**
 * Reads every file in the dir and upserts the ones the agent created or
 * changed back into memory_files. Input-only files and dotfiles are skipped.
 */
export async function syncBack(athleteId: string, folder: HydratedFolder): Promise<void> {
  const db = supabaseAdmin();
  const entries = await readdir(folder.dir, { withFileTypes: true });
  const now = new Date().toISOString();

  const changed: {
    athlete_id: string;
    file_name: string;
    content_md: string;
    updated_at: string;
  }[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.startsWith('.') || INPUT_ONLY_FILES.has(name)) continue;

    const content = await readFile(path.join(folder.dir, name), 'utf8');
    const prior = folder.memoryHashes[name];
    if (prior !== undefined && prior === hash(content)) continue; // unchanged

    changed.push({ athlete_id: athleteId, file_name: name, content_md: content, updated_at: now });
  }

  if (changed.length === 0) return;

  const { error } = await db
    .from('memory_files')
    .upsert(changed, { onConflict: 'athlete_id,file_name' });
  if (error) throw new Error(`syncBack: upsert failed: ${error.message}`);
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

type PlanRefs = {
  planId: string;
  currentVersionId: string;
  currentJson: unknown | null; // working plan (what the calendar renders)
  baselineJson: unknown | null; // original plan of record
};

/**
 * Loads the athlete's working + baseline plan JSON. Self-heals the baseline
 * anchor: a plan with no baseline_version_id yet adopts its current version as
 * the original plan of record, before any coach edit moves current forward.
 */
async function loadPlanRefs(athleteId: string): Promise<PlanRefs | null> {
  const db = supabaseAdmin();
  const { data: plan } = await db
    .from('plans')
    .select('id, current_version_id, baseline_version_id')
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!plan?.current_version_id) return null;

  let baselineVersionId = plan.baseline_version_id;
  if (!baselineVersionId) {
    baselineVersionId = plan.current_version_id;
    await db.from('plans').update({ baseline_version_id: baselineVersionId }).eq('id', plan.id);
  }

  const ids = [...new Set([plan.current_version_id, baselineVersionId])];
  const { data: versions } = await db.from('plan_versions').select('id, plan_json').in('id', ids);
  const byId = new Map((versions ?? []).map((v) => [v.id, v.plan_json]));

  return {
    planId: plan.id,
    currentVersionId: plan.current_version_id,
    currentJson: byId.get(plan.current_version_id) ?? null,
    baselineJson: byId.get(baselineVersionId) ?? null,
  };
}

const NO_DRIFT: PlanDrift = {
  hasEdits: false,
  cumulative: { baselineMiles: 0, workingMiles: 0, deltaMiles: 0, deltaPct: null },
  weeks: [],
  changedWeekCount: 0,
  changedDayCount: 0,
};

function buildDriftMarkdown(refs: PlanRefs | null): string {
  if (!refs?.currentJson || !refs.baselineJson) return renderDriftSummary(NO_DRIFT);
  const working = PlanSchema.safeParse(refs.currentJson);
  const baseline = PlanSchema.safeParse(refs.baselineJson);
  if (!working.success || !baseline.success) return renderDriftSummary(NO_DRIFT);
  return renderDriftSummary(computeDrift(baseline.data, working.data));
}
