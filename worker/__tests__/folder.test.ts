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
const seedPlan = JSON.parse(
  readFileSync(path.join(__dirname, '../../seeds/marathon_training_plan.json'), 'utf8'),
);

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

  it('writes the read-only current-block view when the plan is schema-valid', async () => {
    versionRows = [{ id: 'ver-1', plan_json: seedPlan }];
    const folder = await hydrate(ATHLETE);
    const viewPath = path.join(folder.dir, 'plan_view_readonly.json');
    expect(existsSync(viewPath)).toBe(true);
    const view = JSON.parse(readFileSync(viewPath, 'utf8'));
    expect(view._readonly).toMatch(/READ-ONLY/);
    expect(view.metadata).toBeDefined();
    // It's an input-only file — never recorded as a memory hash.
    expect(Object.keys(folder.memoryHashes)).not.toContain('plan_view_readonly.json');
  });

  it('skips the view when the plan fails schema validation', async () => {
    // The default versionRows ({ weeks: 16 }) is not a valid plan.
    const folder = await hydrate(ATHLETE);
    expect(existsSync(path.join(folder.dir, 'marathon_training_plan.json'))).toBe(true);
    expect(existsSync(path.join(folder.dir, 'plan_view_readonly.json'))).toBe(false);
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

  it('never writes the current-block view back, even if the agent edits it', async () => {
    versionRows = [{ id: 'ver-1', plan_json: seedPlan }];
    const folder = await hydrate(ATHLETE);
    writeFileSync(path.join(folder.dir, 'plan_view_readonly.json'), 'tampered');
    await syncBack(ATHLETE, folder);
    const synced = upsertCalls.flatMap((c) =>
      (c.rows as { file_name: string }[]).map((r) => r.file_name),
    );
    expect(synced).not.toContain('plan_view_readonly.json');
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

// A newest-at-top check-in log over the 20k trigger, spanning `days` distinct
// dates so rotation keeps the recent 14 and archives the rest.
function makeBigCheckinLog(days: number): string {
  const header = '# Check-in Log\n\n<!-- newest at top -->\n';
  const blocks: string[] = [];
  for (let d = days; d >= 1; d--) {
    const date = `2026-06-${String(d).padStart(2, '0')}`;
    blocks.push(`## ${date} — entry\n**Status:** ${'detail '.repeat(120)}\n\n---`);
  }
  return header + blocks.join('\n');
}

describe('checkin_log rotation', () => {
  it('splits an over-cap log into a recent working slice and an archive', async () => {
    const big = makeBigCheckinLog(30);
    expect(big.length).toBeGreaterThan(20_000);
    memoryRows = [{ file_name: 'checkin_log.md', content_md: big }];

    const folder = await hydrate(ATHLETE);
    const working = readFileSync(path.join(folder.dir, 'checkin_log.md'), 'utf8');
    const archive = readFileSync(path.join(folder.dir, 'checkin_log_archive.md'), 'utf8');

    expect(working).toContain('# Check-in Log'); // preamble retained
    expect(working).toContain('2026-06-30'); // recent kept
    expect(working).not.toContain('2026-06-01'); // old moved out
    expect(archive).toContain('2026-06-01');
    expect(archive).not.toContain('2026-06-30');
    expect(working.length).toBeLessThan(big.length);
  });

  it('persists both the shrunk log and the archive on syncBack, with no agent edit', async () => {
    memoryRows = [{ file_name: 'checkin_log.md', content_md: makeBigCheckinLog(30) }];
    const folder = await hydrate(ATHLETE);
    await syncBack(ATHLETE, folder);

    const synced = upsertCalls.flatMap((c) =>
      (c.rows as { file_name: string }[]).map((r) => r.file_name),
    );
    expect(synced).toContain('checkin_log.md');
    expect(synced).toContain('checkin_log_archive.md');
  });

  it('accumulates the archive across runs when one already exists', async () => {
    const priorArchive = '## 2026-05-20 — prior\n**Status:** older history\n\n---';
    memoryRows = [
      { file_name: 'checkin_log.md', content_md: makeBigCheckinLog(30) },
      { file_name: 'checkin_log_archive.md', content_md: priorArchive },
    ];
    const folder = await hydrate(ATHLETE);
    const archive = readFileSync(path.join(folder.dir, 'checkin_log_archive.md'), 'utf8');
    expect(archive).toContain('2026-05-20'); // prior archive preserved
    expect(archive).toContain('2026-06-01'); // newly moved entries appended
  });

  it("preserves the agent's appended entry on the shrunk log", async () => {
    memoryRows = [{ file_name: 'checkin_log.md', content_md: makeBigCheckinLog(30) }];
    const folder = await hydrate(ATHLETE);

    const working = readFileSync(path.join(folder.dir, 'checkin_log.md'), 'utf8');
    writeFileSync(
      path.join(folder.dir, 'checkin_log.md'),
      working + '\n## 2026-06-30 — new entry\n**Status:** appended this run\n\n---',
    );
    await syncBack(ATHLETE, folder);

    const row = upsertCalls
      .flatMap((c) => c.rows as { file_name: string; content_md: string }[])
      .find((r) => r.file_name === 'checkin_log.md')!;
    expect(row.content_md).toContain('appended this run');
    expect(row.content_md).not.toContain('2026-06-01'); // still the shrunk base
  });

  it('reconstructs full history from the synced log plus archive', async () => {
    const big = makeBigCheckinLog(30);
    memoryRows = [{ file_name: 'checkin_log.md', content_md: big }];
    const folder = await hydrate(ATHLETE);
    await syncBack(ATHLETE, folder);

    const rows = upsertCalls.flatMap((c) => c.rows as { file_name: string; content_md: string }[]);
    const working = rows.find((r) => r.file_name === 'checkin_log.md')!.content_md;
    const archive = rows.find((r) => r.file_name === 'checkin_log_archive.md')!.content_md;
    for (let d = 1; d <= 30; d++) {
      expect(working + archive).toContain(`2026-06-${String(d).padStart(2, '0')}`);
    }
  });

  it('is a no-op for an under-cap log — no archive, no upsert', async () => {
    memoryRows = [{ file_name: 'checkin_log.md', content_md: '## 2026-06-24 — small\nok' }];
    const folder = await hydrate(ATHLETE);
    expect(existsSync(path.join(folder.dir, 'checkin_log_archive.md'))).toBe(false);
    await syncBack(ATHLETE, folder);
    expect(upsertCalls).toHaveLength(0);
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
