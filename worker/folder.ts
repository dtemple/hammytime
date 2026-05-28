// Per-athlete working-directory lifecycle (M1 plan §3.3, §4).
//
// memory_files (rows of athlete_id, file_name, content_md) is the source of
// truth. For each run we hydrate those rows to disk, let the agent read/write
// real files, then sync changed/new files back. Two input-only files are also
// written for the agent to read but are NEVER synced back: the pre-fetched
// Strava context and the immutable training plan.

import { createHash } from 'crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { supabaseAdmin } from '@/lib/db';
import { ATHLETE_ROOT, STRAVA_LOOKBACK_DAYS } from './config';
import { buildStravaContext } from './strava';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Files the worker writes as agent input — excluded from sync-back so the agent
// can't accidentally persist them into memory_files.
export const INPUT_ONLY_FILES = new Set(['strava_recent.json', 'marathon_training_plan.json']);

export type HydratedFolder = {
  dir: string;
  // file_name -> sha256 of the content written at hydrate time. Used by
  // syncBack to detect which files the agent actually changed.
  memoryHashes: Record<string, string>;
};

function hash(content: string): string {
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

  // Active training plan (immutable input) — written as JSON if one exists.
  const planJson = await loadActivePlanJson(athleteId);
  if (planJson != null) {
    await writeFile(
      path.join(dir, 'marathon_training_plan.json'),
      JSON.stringify(planJson, null, 2),
      'utf8',
    );
  }

  // Pre-fetched Strava context (input). The coach reads this instead of
  // spawning a fetch — see isolation.ts for why Bash stays denied.
  const strava = await buildStravaContext(athleteId, STRAVA_LOOKBACK_DAYS);
  await writeFile(
    path.join(dir, 'strava_recent.json'),
    JSON.stringify(strava, null, 2),
    'utf8',
  );

  return { dir, memoryHashes };
}

/**
 * Reads every file in the dir and upserts the ones the agent created or
 * changed back into memory_files. Input-only files and dotfiles are skipped.
 */
export async function syncBack(athleteId: string, folder: HydratedFolder): Promise<void> {
  const db = supabaseAdmin();
  const entries = await readdir(folder.dir, { withFileTypes: true });
  const now = new Date().toISOString();

  const changed: { athlete_id: string; file_name: string; content_md: string; updated_at: string }[] =
    [];

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

async function loadActivePlanJson(athleteId: string): Promise<unknown | null> {
  const db = supabaseAdmin();
  const { data: plan } = await db
    .from('plans')
    .select('current_version_id')
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!plan?.current_version_id) return null;

  const { data: version } = await db
    .from('plan_versions')
    .select('plan_json')
    .eq('id', plan.current_version_id)
    .maybeSingle();

  return version?.plan_json ?? null;
}
