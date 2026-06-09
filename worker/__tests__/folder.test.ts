import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs';
import path from 'path';

// Point ATHLETE_ROOT at a throwaway temp dir so hydrate/cleanup hit real disk
// without touching /data/athletes.
vi.mock('../config', async () => {
  const os = await import('os');
  const fs = await import('fs');
  const p = await import('path');
  const root = fs.mkdtempSync(p.join(os.tmpdir(), 'folder-root-'));
  return { ATHLETE_ROOT: root, STRAVA_LOOKBACK_DAYS: 14 };
});

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('../strava', () => ({ buildStravaContext: vi.fn() }));

import { hydrate, syncBack, cleanup, INPUT_ONLY_FILES } from '../folder';
import { ATHLETE_ROOT } from '../config';
import { supabaseAdmin } from '@/lib/db';
import { buildStravaContext } from '../strava';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE = '11111111-2222-3333-4444-555555555555';

let memoryRows: { file_name: string; content_md: string }[];
let planRow: {
  id: string;
  current_version_id: string | null;
  baseline_version_id: string | null;
} | null;
let versionRows: { id: string; plan_json: unknown }[];
let upsertCalls: { rows: unknown[]; opts: unknown }[];
let planUpdateCalls: unknown[];

function makeDb() {
  return {
    from(table: string) {
      if (table === 'memory_files') {
        return {
          select: () => ({ eq: () => ({ data: memoryRows, error: null }) }),
          upsert: (rows: unknown[], opts: unknown) => {
            upsertCalls.push({ rows, opts });
            return { error: null };
          },
        };
      }
      if (table === 'plans') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({ limit: () => ({ maybeSingle: () => ({ data: planRow }) }) }),
            }),
          }),
          update: (vals: unknown) => ({
            eq: () => {
              planUpdateCalls.push(vals);
              return { error: null };
            },
          }),
        };
      }
      if (table === 'plan_versions') {
        return { select: () => ({ in: () => ({ data: versionRows, error: null }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

beforeEach(() => {
  memoryRows = [
    { file_name: 'athlete_profile.md', content_md: '# Profile' },
    { file_name: 'latest_state.md', content_md: 'state v1' },
  ];
  planRow = { id: 'plan-1', current_version_id: 'ver-1', baseline_version_id: 'ver-1' };
  versionRows = [{ id: 'ver-1', plan_json: { weeks: 16 } }];
  upsertCalls = [];
  planUpdateCalls = [];
  (supabaseAdmin as AnyMock).mockImplementation(() => makeDb());
  (buildStravaContext as AnyMock).mockResolvedValue({ connected: true, activities: [] });
});

afterEach(() => {
  rmSync(ATHLETE_ROOT, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('hydrate', () => {
  it('writes every memory row plus the input-only plan and strava files', async () => {
    const folder = await hydrate(ATHLETE);
    expect(folder.dir).toBe(path.join(ATHLETE_ROOT, ATHLETE));

    expect(readFileSync(path.join(folder.dir, 'athlete_profile.md'), 'utf8')).toBe('# Profile');
    expect(readFileSync(path.join(folder.dir, 'latest_state.md'), 'utf8')).toBe('state v1');
    expect(existsSync(path.join(folder.dir, 'marathon_training_plan.json'))).toBe(true);
    expect(existsSync(path.join(folder.dir, 'plan_drift.md'))).toBe(true);
    expect(existsSync(path.join(folder.dir, 'strava_recent.json'))).toBe(true);
    expect(folder.planHash).toBeDefined();

    // The static knowledge corpora are copied in for the coach to read.
    const corpus = readFileSync(path.join(folder.dir, 'exercises.md'), 'utf8');
    expect(corpus).toContain('# Exercise library');
    const principles = readFileSync(path.join(folder.dir, 'prehab-principles.md'), 'utf8');
    expect(principles).toContain('# Prehab principles');
    // They are not memory files — no hash recorded, so syncBack treats them as input.
    expect(Object.keys(folder.memoryHashes)).not.toContain('exercises.md');
    expect(Object.keys(folder.memoryHashes)).not.toContain('prehab-principles.md');

    expect(Object.keys(folder.memoryHashes).sort()).toEqual([
      'athlete_profile.md',
      'latest_state.md',
    ]);
  });

  it('self-heals a missing baseline anchor to the current version', async () => {
    planRow = { id: 'plan-1', current_version_id: 'ver-1', baseline_version_id: null };
    await hydrate(ATHLETE);
    expect(planUpdateCalls).toEqual([{ baseline_version_id: 'ver-1' }]);
  });

  it('refuses a non-uuid athlete id', async () => {
    await expect(hydrate('../escape')).rejects.toThrow(/non-uuid/);
  });

  it('survives an athlete with zero memory files and no plan', async () => {
    memoryRows = [];
    planRow = null;
    const folder = await hydrate(ATHLETE);
    expect(existsSync(path.join(folder.dir, 'marathon_training_plan.json'))).toBe(false);
    expect(existsSync(path.join(folder.dir, 'strava_recent.json'))).toBe(true);
    expect(Object.keys(folder.memoryHashes)).toEqual([]);
  });
});

describe('syncBack', () => {
  it('upserts only changed and new files, never the input-only files', async () => {
    const folder = await hydrate(ATHLETE);

    // Agent edits one memory file, leaves the other unchanged, creates a new
    // one, and (illegally) rewrites an input-only file.
    writeFileSync(path.join(folder.dir, 'latest_state.md'), 'state v2');
    writeFileSync(path.join(folder.dir, 'training_log.md'), 'new log');
    writeFileSync(path.join(folder.dir, 'strava_recent.json'), 'tampered');

    await syncBack(ATHLETE, folder);

    expect(upsertCalls).toHaveLength(1);
    const rows = upsertCalls[0]!.rows as { file_name: string; content_md: string }[];
    const names = rows.map((r) => r.file_name).sort();
    expect(names).toEqual(['latest_state.md', 'training_log.md']);
    expect(rows.find((r) => r.file_name === 'latest_state.md')!.content_md).toBe('state v2');
    for (const input of INPUT_ONLY_FILES) {
      expect(names).not.toContain(input);
    }
  });

  it('no-ops when nothing changed', async () => {
    const folder = await hydrate(ATHLETE);
    await syncBack(ATHLETE, folder);
    expect(upsertCalls).toHaveLength(0);
  });

  it('never writes a knowledge corpus back, even if the agent edits it', async () => {
    const folder = await hydrate(ATHLETE);
    writeFileSync(path.join(folder.dir, 'exercises.md'), 'tampered');
    writeFileSync(path.join(folder.dir, 'prehab-principles.md'), 'tampered');
    await syncBack(ATHLETE, folder);
    const synced = upsertCalls.flatMap((c) =>
      (c.rows as { file_name: string }[]).map((r) => r.file_name),
    );
    expect(synced).not.toContain('exercises.md');
    expect(synced).not.toContain('prehab-principles.md');
  });

  it('syncs back an agent-authored prehab_program.md', async () => {
    const folder = await hydrate(ATHLETE);
    writeFileSync(path.join(folder.dir, 'prehab_program.md'), '# Prehab program — Sam');
    await syncBack(ATHLETE, folder);
    expect(upsertCalls).toHaveLength(1);
    const rows = upsertCalls[0]!.rows as { file_name: string; content_md: string }[];
    expect(rows.map((r) => r.file_name)).toEqual(['prehab_program.md']);
    expect(rows[0]!.content_md).toBe('# Prehab program — Sam');
  });
});

describe('cleanup', () => {
  it('removes the folder', async () => {
    const folder = await hydrate(ATHLETE);
    expect(existsSync(folder.dir)).toBe(true);
    await cleanup(folder.dir);
    expect(existsSync(folder.dir)).toBe(false);
  });

  it('leaves dotfiles out of sync', async () => {
    const folder = await hydrate(ATHLETE);
    writeFileSync(path.join(folder.dir, '.hidden'), 'x');
    await syncBack(ATHLETE, folder);
    expect(readdirSync(folder.dir)).toContain('.hidden');
    expect(upsertCalls).toHaveLength(0);
  });
});
