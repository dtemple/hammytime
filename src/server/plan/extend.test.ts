import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/jobs/enqueue', () => ({ enqueueJob: vi.fn() }));
vi.mock('@/server/strava/activities', () => ({ getFitnessSnapshot: vi.fn() }));
vi.mock('@/server/telegram/onboarding/athlete-training-profile', () => ({
  getTrainingProfile: vi.fn(),
}));
vi.mock('@/server/telegram/onboarding/plan-gen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/telegram/onboarding/plan-gen')>();
  return { ...actual, buildSelectorProfile: vi.fn() };
});

import { supabaseAdmin } from '@/lib/db';
import { enqueueJob } from '@/server/jobs/enqueue';
import { getFitnessSnapshot } from '@/server/strava/activities';
import { getTrainingProfile } from '@/server/telegram/onboarding/athlete-training-profile';
import { buildSelectorProfile, todayInTz } from '@/server/telegram/onboarding/plan-gen';
import {
  selectPlan,
  renderPlan,
  DRAFT_SAFETY_CAPS,
  type FitnessSnapshotInput,
  type SelectorProfile,
} from '@/lib/plan-templates';
import { addDays, mondayOf } from '@/lib/plan-templates/dates';
import { PlanSchema, type Plan } from '@/lib/plan-schema';
import { extendPlanIfDue } from './extend';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-1';
const TODAY = todayInTz('America/Los_Angeles'); // extend.ts computes real today

const SNAP: FitnessSnapshotInput = {
  recentWeeklyMileageMi: 26,
  avgWeeklyMileageMi: 24,
  longestRunMi: 9,
  runsPerWeek: 4,
  suggestedDaysPerWeek: 4,
  dominantLongRunWeekday: 0,
  roadTrailMix: { road: 1, trail: 0 },
};

function keepFitProfile(today: string): SelectorProfile {
  return {
    experienceTier: 'experienced',
    goalDistance: 'keep_fit',
    daysPerWeek: 4,
    longRunDay: 0,
    goalState: 'day_to_day',
    targetDate: null,
    targetType: 'finish',
    targetTimeSec: null,
    race: null,
    injuries: [],
    today,
  };
}

/** A keep_fit working plan rendered to start `weeksAgo` weeks before today —
 *  weeksAgo ≥ 7 leaves ≤ ~13 future days on an 8-week block. */
function workingPlan(weeksAgo: number): Plan {
  const start = addDays(mondayOf(TODAY), -7 * weeksAgo);
  const { template, params } = selectPlan(keepFitProfile(start), SNAP, DRAFT_SAFETY_CAPS);
  return renderPlan(template, params);
}

type DbRows = {
  athlete?: { timezone: string } | null;
  plan?: { id: string; current_version_id: string | null } | null;
  version?: { id: string; plan_json: unknown; status: string } | null;
  oauth?: { id: string } | null;
};

/** Chainable supabase fake: from(table) → any chain → maybeSingle resolves the
 *  row configured for that table; rpc records its args. */
function makeDb(rows: DbRows) {
  const byTable: Record<string, unknown> = {
    athletes: rows.athlete ?? { timezone: 'America/Los_Angeles' },
    plans: rows.plan ?? null,
    plan_versions: rows.version ?? null,
    oauth_tokens: rows.oauth ?? null,
  };
  const rpc = vi.fn().mockResolvedValue({ data: 'new-version-id', error: null });
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: byTable[table] ?? null, error: null });
    return chain;
  });
  return { from, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  (enqueueJob as AnyMock).mockResolvedValue(undefined);
  (getFitnessSnapshot as AnyMock).mockResolvedValue(null); // default: seed from plan
  (getTrainingProfile as AnyMock).mockResolvedValue({
    goal_state: 'day_to_day',
    goal_race_id: null,
  });
  (buildSelectorProfile as AnyMock).mockImplementation(
    async (_id: string, today: string) => keepFitProfile(today),
  );
});

describe('extendPlanIfDue — gates', () => {
  it('returns null for a committed athlete without touching the plan', async () => {
    (getTrainingProfile as AnyMock).mockResolvedValue({
      goal_state: 'committed',
      goal_race_id: 'race-1',
    });
    const db = makeDb({});
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    expect(await extendPlanIfDue(ATHLETE_ID)).toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('returns null for an intended athlete WITH a bound race', async () => {
    (getTrainingProfile as AnyMock).mockResolvedValue({
      goal_state: 'intended',
      goal_race_id: 'race-1',
    });
    const db = makeDb({});
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    expect(await extendPlanIfDue(ATHLETE_ID)).toBeNull();
  });

  it('returns null when the plan still has more than 14 future days', async () => {
    const plan = workingPlan(0); // freshly started 8-week block
    const db = makeDb({
      plan: { id: 'plan-1', current_version_id: 'v-1' },
      version: { id: 'v-1', plan_json: plan, status: 'active' },
    });
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    expect(await extendPlanIfDue(ATHLETE_ID)).toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('returns null when there is no plan row', async () => {
    const db = makeDb({ plan: null });
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    expect(await extendPlanIfDue(ATHLETE_ID)).toBeNull();
  });
});

describe('extendPlanIfDue — publish path', () => {
  it('extends a nearly-exhausted plan: valid merged JSON via RPC, baseline-repointing args', async () => {
    const plan = workingPlan(7); // ≤ ~13 future days
    const db = makeDb({
      plan: { id: 'plan-1', current_version_id: 'v-1' },
      version: { id: 'v-1', plan_json: plan, status: 'active' },
    });
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const result = await extendPlanIfDue(ATHLETE_ID);
    expect(result).toMatchObject({ extended: true, versionId: 'new-version-id', blockWeeks: 8 });

    expect(db.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = (db.rpc as AnyMock).mock.calls[0];
    expect(fn).toBe('record_plan_extension');
    expect(args.p_plan_id).toBe('plan-1');
    expect(args.p_supersedes_version_id).toBe('v-1');
    expect(args.p_total_weeks).toBe(16);

    const merged = PlanSchema.parse(args.p_plan_json);
    expect(merged.weeks.length).toBe(16);
    // old weeks intact, continuation starts the Monday after the old end
    expect(merged.weeks.slice(0, 8)).toEqual(plan.weeks);
    expect(merged.weeks[8]!.start_date).toBe(addDays(plan.weeks[7]!.end_date!, 1));
    expect(merged.weeks[8]!.coaching_note?.startsWith('Ease-in week')).toBe(false);
    expect(result!.newEndDate).toBe(merged.metadata.plan_structure.end_date);
  });

  it('enqueues calendar_sync only for a Google-connected athlete', async () => {
    const plan = workingPlan(7);
    const connected = makeDb({
      plan: { id: 'plan-1', current_version_id: 'v-1' },
      version: { id: 'v-1', plan_json: plan, status: 'active' },
      oauth: { id: 'tok-1' },
    });
    (supabaseAdmin as AnyMock).mockReturnValue(connected);
    await extendPlanIfDue(ATHLETE_ID);
    expect(enqueueJob).toHaveBeenCalledWith(
      'calendar_sync',
      expect.stringContaining(`calsync-${ATHLETE_ID}-new-version-id-`),
      { athlete_id: ATHLETE_ID, reason: 'plan_extend' },
    );

    vi.clearAllMocks();
    (getTrainingProfile as AnyMock).mockResolvedValue({
      goal_state: 'day_to_day',
      goal_race_id: null,
    });
    (buildSelectorProfile as AnyMock).mockImplementation(
      async (_id: string, today: string) => keepFitProfile(today),
    );
    (getFitnessSnapshot as AnyMock).mockResolvedValue(null);
    const disconnected = makeDb({
      plan: { id: 'plan-1', current_version_id: 'v-1' },
      version: { id: 'v-1', plan_json: plan, status: 'active' },
      oauth: null,
    });
    (supabaseAdmin as AnyMock).mockReturnValue(disconnected);
    await extendPlanIfDue(ATHLETE_ID);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('with Strava down, seeds from the plan: continuation volume stays near the trained level', async () => {
    (getFitnessSnapshot as AnyMock).mockRejectedValue(new Error('token broken'));
    const plan = workingPlan(7);
    const db = makeDb({
      plan: { id: 'plan-1', current_version_id: 'v-1' },
      version: { id: 'v-1', plan_json: plan, status: 'active' },
    });
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    await extendPlanIfDue(ATHLETE_ID);
    const merged = PlanSchema.parse((db.rpc as AnyMock).mock.calls[0][1].p_plan_json);
    // base-maintenance floors at 12 mi/wk; trained athlete must not be reset.
    expect(merged.weeks[8]!.planned_total_run_miles!).toBeGreaterThan(15);
  });

  it('carries forward the strength opt-out from the working plan', async () => {
    const plan = workingPlan(7);
    plan.metadata.plan_structure.strength_sessions_per_week = 0;
    for (const w of plan.weeks) {
      w.days = w.days.map((d) =>
        d.category === 'strength'
          ? { day: d.day, date: d.date, type: 'rest' as const, description: 'Rest day.' }
          : d,
      );
    }
    delete plan.strength_workouts;
    const db = makeDb({
      plan: { id: 'plan-1', current_version_id: 'v-1' },
      version: { id: 'v-1', plan_json: plan, status: 'active' },
    });
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    await extendPlanIfDue(ATHLETE_ID);
    const merged = PlanSchema.parse((db.rpc as AnyMock).mock.calls[0][1].p_plan_json);
    const contDays = merged.weeks.slice(8).flatMap((w) => w.days);
    expect(contDays.some((d) => d.category === 'strength')).toBe(false);
  });

  it('nulls a stale target_date so an intended athlete gets a full open-ended block', async () => {
    (getTrainingProfile as AnyMock).mockResolvedValue({
      goal_state: 'intended',
      goal_race_id: null,
    });
    (buildSelectorProfile as AnyMock).mockImplementation(
      async (_id: string, today: string): Promise<SelectorProfile> => ({
        ...keepFitProfile(today),
        goalDistance: 'half',
        goalState: 'intended',
        targetDate: addDays(TODAY, -30), // already passed
      }),
    );
    const plan = workingPlan(7);
    const db = makeDb({
      plan: { id: 'plan-1', current_version_id: 'v-1' },
      version: { id: 'v-1', plan_json: plan, status: 'active' },
    });
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const result = await extendPlanIfDue(ATHLETE_ID);
    // open-ended non-keep_fit block is 12 weeks — a stale date would clamp to 1
    expect(result!.blockWeeks).toBe(12);
  });

  it('throws when the RPC fails (caller alerts David, daily run proceeds)', async () => {
    const plan = workingPlan(7);
    const db = makeDb({
      plan: { id: 'plan-1', current_version_id: 'v-1' },
      version: { id: 'v-1', plan_json: plan, status: 'active' },
    });
    db.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    await expect(extendPlanIfDue(ATHLETE_ID)).rejects.toThrow(/record_plan_extension failed/);
  });
});
