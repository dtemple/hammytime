import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

// folder.ts pulls in config/strava/db at import time — stub them so importing
// plan-version (which imports folder) doesn't touch the real worker config.
vi.mock('../config', async () => {
  const fs = await import('fs');
  const p = await import('path');
  const o = await import('os');
  const root = fs.mkdtempSync(p.join(o.tmpdir(), 'pv-root-'));
  return { ATHLETE_ROOT: root, STRAVA_LOOKBACK_DAYS: 14 };
});
vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('../strava', () => ({ buildStravaContext: vi.fn() }));

import { persistPlanEdit } from '../plan-version';
import { hash, type HydratedFolder } from '../folder';
import { supabaseAdmin } from '@/lib/db';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE = '11111111-2222-3333-4444-555555555555';
const seedPath = path.join(__dirname, '../../seeds/marathon_training_plan.json');
const seedJson = readFileSync(seedPath, 'utf8');

let dir: string;
let rpcCalls: { name: string; args: Record<string, unknown> }[];
let planRow: { id: string; current_version_id: string | null } | null;

function makeDb() {
  return {
    from(table: string) {
      if (table === 'plans') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({ limit: () => ({ maybeSingle: () => ({ data: planRow }) }) }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return { data: 'new-version-id', error: null };
    },
  };
}

function folderWithPlan(content: string): HydratedFolder {
  writeFileSync(path.join(dir, 'marathon_training_plan.json'), content);
  return { dir, memoryHashes: {}, planHash: hash(content), plan: null };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pv-folder-'));
  rpcCalls = [];
  planRow = { id: 'plan-1', current_version_id: 'ver-1' };
  (supabaseAdmin as AnyMock).mockImplementation(() => makeDb());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('persistPlanEdit', () => {
  it('no-ops when the athlete had no plan at hydrate', async () => {
    await persistPlanEdit(ATHLETE, { dir, memoryHashes: {}, planHash: undefined, plan: null });
    expect(rpcCalls).toHaveLength(0);
  });

  it('no-ops when the plan file is unchanged', async () => {
    const folder = folderWithPlan(seedJson);
    await persistPlanEdit(ATHLETE, folder);
    expect(rpcCalls).toHaveLength(0);
  });

  it('drops a schema-invalid edit without writing a version', async () => {
    const folder = folderWithPlan(seedJson);
    writeFileSync(path.join(dir, 'marathon_training_plan.json'), '{"weeks":[]}');
    await persistPlanEdit(ATHLETE, folder);
    expect(rpcCalls).toHaveLength(0);
  });

  it('publishes a changed, valid edit via record_plan_edit', async () => {
    const folder = folderWithPlan(seedJson);

    const edited = JSON.parse(seedJson);
    edited.weeks[0].days[0].planned_distance_miles = 99; // change content, stay schema-valid
    writeFileSync(path.join(dir, 'marathon_training_plan.json'), JSON.stringify(edited));

    await persistPlanEdit(ATHLETE, folder);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.name).toBe('record_plan_edit');
    expect(rpcCalls[0]!.args.p_plan_id).toBe('plan-1');
    expect(rpcCalls[0]!.args.p_supersedes_version_id).toBe('ver-1');
    expect(rpcCalls[0]!.args.p_total_weeks).toBe(edited.weeks.length);
    expect(rpcCalls[0]!.args.p_start_date).toBe(edited.metadata.plan_structure.start_date);
  });
});
