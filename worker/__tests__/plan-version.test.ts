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

import { persistPlanEdit, proposalExpiry } from '../plan-version';
import { hash, type HydratedFolder } from '../folder';
import { supabaseAdmin } from '@/lib/db';
import type { Plan } from '@/lib/plan-schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE = '11111111-2222-3333-4444-555555555555';
const TZ = 'America/Los_Angeles';
const seedPath = path.join(__dirname, '../../seeds/marathon_training_plan.json');
const seedJson = readFileSync(seedPath, 'utf8');

let dir: string;
let rpcCalls: { name: string; args: Record<string, unknown> }[];
let planRow: {
  id: string;
  current_version_id: string | null;
  proposed_message_id: number | null;
} | null;

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
  planRow = { id: 'plan-1', current_version_id: 'ver-1', proposed_message_id: null };
  (supabaseAdmin as AnyMock).mockImplementation(() => makeDb());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('persistPlanEdit', () => {
  it('no-ops when the athlete had no plan at hydrate', async () => {
    const r = await persistPlanEdit(
      ATHLETE,
      { dir, memoryHashes: {}, planHash: undefined, plan: null },
      TZ,
    );
    expect(r.outcome).toBe('no_plan');
    expect(rpcCalls).toHaveLength(0);
  });

  it('no-ops when the plan file is unchanged', async () => {
    const folder = folderWithPlan(seedJson);
    const r = await persistPlanEdit(ATHLETE, folder, TZ);
    expect(r.outcome).toBe('unchanged');
    expect(rpcCalls).toHaveLength(0);
  });

  it('drops a schema-invalid edit without staging a version', async () => {
    const folder = folderWithPlan(seedJson);
    writeFileSync(path.join(dir, 'marathon_training_plan.json'), '{"weeks":[]}');
    const r = await persistPlanEdit(ATHLETE, folder, TZ);
    expect(r.outcome).toBe('dropped_schema');
    expect(r.detail).toBeTruthy();
    expect(rpcCalls).toHaveLength(0);
  });

  it('drops an edit that is not valid JSON without staging a version', async () => {
    const folder = folderWithPlan(seedJson);
    writeFileSync(path.join(dir, 'marathon_training_plan.json'), '{not json');
    const r = await persistPlanEdit(ATHLETE, folder, TZ);
    expect(r.outcome).toBe('dropped_invalid_json');
    expect(rpcCalls).toHaveLength(0);
  });

  it('stages a changed, valid edit via propose_plan_edit with a token and ISO expiry', async () => {
    const folder = folderWithPlan(seedJson);

    const edited = JSON.parse(seedJson);
    edited.weeks[0].days[0].planned_distance_miles = 99; // change content, stay schema-valid
    writeFileSync(path.join(dir, 'marathon_training_plan.json'), JSON.stringify(edited));

    const before = Date.now();
    const r = await persistPlanEdit(ATHLETE, folder, TZ);

    expect(r.outcome).toBe('proposed');
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{12}$/); // base64url, fits callback_data
    expect(r.supersededMessageId).toBeUndefined(); // no prior outstanding keyboard

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.name).toBe('propose_plan_edit');
    const args = rpcCalls[0]!.args;
    expect(args.p_plan_id).toBe('plan-1');
    expect(args.p_based_on_version_id).toBe('ver-1');
    expect(args.p_token).toBe(r.token);
    const expiry = Date.parse(args.p_expires_at as string);
    expect(Number.isNaN(expiry)).toBe(false);
    expect(expiry).toBeGreaterThan(before);
    expect(expiry).toBeLessThanOrEqual(before + 72 * 3600 * 1000 + 1000);
  });

  it('surfaces the prior outstanding keyboard message id for the supersede edit', async () => {
    planRow = { id: 'plan-1', current_version_id: 'ver-1', proposed_message_id: 777 };
    const folder = folderWithPlan(seedJson);

    const edited = JSON.parse(seedJson);
    edited.weeks[0].days[0].planned_distance_miles = 42;
    writeFileSync(path.join(dir, 'marathon_training_plan.json'), JSON.stringify(edited));

    const r = await persistPlanEdit(ATHLETE, folder, TZ);
    expect(r.outcome).toBe('proposed');
    expect(r.supersededMessageId).toBe(777);
  });
});

// ---------------------------------------------------------------------------
// proposalExpiry — pure. Fixed "now": Friday 2026-06-12 10:00 PDT.
// ---------------------------------------------------------------------------

function day(date: string, miles: number) {
  return { day: 'X', date, type: 'easy' as const, description: `easy ${miles}`, planned_distance_miles: miles };
}

function makePlan(weeks: { start: string; end: string; days: ReturnType<typeof day>[] }[]): Plan {
  return {
    metadata: {
      race: { name: 'Test Race', date: '2026-09-01', distance_miles: 26.2 },
      plan_structure: { total_weeks: weeks.length, start_date: weeks[0]!.start },
    },
    weeks: weeks.map((w, i) => ({
      week_number: i + 1,
      start_date: w.start,
      end_date: w.end,
      phase: 'base' as const,
      days: w.days,
    })),
  } as Plan;
}

const WEEKS = [
  { start: '2026-06-08', end: '2026-06-14', days: [day('2026-06-09', 4), day('2026-06-13', 6)] },
  { start: '2026-06-15', end: '2026-06-21', days: [day('2026-06-17', 5)] },
  { start: '2026-06-22', end: '2026-06-28', days: [day('2026-06-24', 5)] },
];

function editedAt(date: string, miles: number): Plan {
  const weeks = WEEKS.map((w) => ({
    ...w,
    days: w.days.map((d) => (d.date === date ? day(date, miles) : d)),
  }));
  return makePlan(weeks);
}

describe('proposalExpiry', () => {
  const oldPlan = makePlan(WEEKS);
  const now = new Date('2026-06-12T17:00:00Z'); // Fri 10:00 PDT
  const cap = new Date(now.getTime() + 72 * 3600 * 1000);

  it('expires at the end of the affected week when that lands inside 72h', () => {
    // Tomorrow (Sat 06-13) changes; its week ends Sun 06-14 → Sun 23:59:59 PDT.
    const expiry = proposalExpiry(oldPlan, editedAt('2026-06-13', 10), now, TZ);
    expect(expiry.toISOString()).toBe('2026-06-15T06:59:59.000Z');
  });

  it('caps at 72h when the affected week ends later than that', () => {
    // A change two weeks out — week ends 06-28, far past the cap.
    const expiry = proposalExpiry(oldPlan, editedAt('2026-06-24', 10), now, TZ);
    expect(expiry.toISOString()).toBe(cap.toISOString());
  });

  it('falls back to 72h when no changed day is after today', () => {
    // Only a past day (Tue 06-09) changed.
    const expiry = proposalExpiry(oldPlan, editedAt('2026-06-09', 10), now, TZ);
    expect(expiry.toISOString()).toBe(cap.toISOString());
  });

  it('treats a removed future date as changed', () => {
    // Sat 06-13 disappears from the new plan; its week (from the old plan) ends 06-14.
    const weeks = WEEKS.map((w) => ({
      ...w,
      days: w.days.filter((d) => d.date !== '2026-06-13'),
    }));
    const expiry = proposalExpiry(oldPlan, makePlan(weeks), now, TZ);
    expect(expiry.toISOString()).toBe('2026-06-15T06:59:59.000Z');
  });

  it('uses the athlete-local date — a late-evening propose still sees tomorrow as future', () => {
    // 22:00 PDT Tue 06-09 is already 06-10 in UTC. A change on 06-10 must read
    // as future (athlete-local today is still 06-09). Week 1 ends 06-14 →
    // before the 72h cap (Fri 06-12 05:00Z + 67h)? No: Sun 23:59:59 PDT =
    // 06-15T06:59:59Z vs cap 06-13T05:00Z — cap wins; assert via a one-day week.
    const lateNow = new Date('2026-06-10T05:00:00Z'); // Tue 22:00 PDT
    const shortWeek = [
      { start: '2026-06-08', end: '2026-06-10', days: [day('2026-06-09', 4), day('2026-06-10', 5)] },
    ];
    const before = makePlan(shortWeek);
    const after = makePlan([
      { ...shortWeek[0]!, days: [day('2026-06-09', 4), day('2026-06-10', 8)] },
    ]);
    const expiry = proposalExpiry(before, after, lateNow, TZ);
    // End of the affected (short) week: Wed 06-10 23:59:59 PDT.
    expect(expiry.toISOString()).toBe('2026-06-11T06:59:59.000Z');
  });
});
