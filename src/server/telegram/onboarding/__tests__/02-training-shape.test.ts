import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/strava/activities', () => ({ getFitnessSnapshot: vi.fn() }));
vi.mock('../memory', () => ({ upsertProfileSection: vi.fn() }));
vi.mock('../athlete-training-profile', () => ({ upsertTrainingProfile: vi.fn() }));

import { getFitnessSnapshot } from '@/server/strava/activities';
import { trainingShapeStep } from '../steps/02-training-shape';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const cb = (data: string, partial: Record<string, unknown> = {}) =>
  trainingShapeStep.handleCallback!(data, partial, 'a1');

const SNAPSHOT = {
  window_days: 56,
  activity_count: 20,
  run_count: 20,
  weeks_observed: 8,
  recent_weekly_mileage_mi: 30,
  avg_weekly_mileage_mi: 28,
  longest_run_mi: 12,
  runs_per_week: 4,
  suggested_days_per_week: 5,
  dominant_long_run_weekday: 0, // Sunday
  road_trail_mix: { road: 0.8, trail: 0.2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  (getFitnessSnapshot as AnyMock).mockResolvedValue(SNAPSHOT);
});

describe('training-shape — A3 → A5 → A6 chain', () => {
  it('experience tap advances to days with the Strava-suggested default', async () => {
    const r = await cb('exp:some_training');
    expect(r.done).toBe(false);
    const p = r.newPartial as { sub_step: string; experience_tier: string; suggested_days: number };
    expect(p.sub_step).toBe('days');
    expect(p.experience_tier).toBe('some_training');
    expect(p.suggested_days).toBe(5);
    if (!r.done) expect(r.reply).toContain('5 days');
  });

  it('days tap advances to long-run, surfacing the dominant weekday', async () => {
    const r = await cb('days:4', { sub_step: 'days', suggested_long_run: 0 });
    expect((r.newPartial as { sub_step: string; days_per_week: number }).days_per_week).toBe(4);
    expect((r.newPartial as { sub_step: string }).sub_step).toBe('long_run');
    if (!r.done) expect(r.reply).toContain('Sun');
  });

  it('long-run tap completes the step', async () => {
    const r = await cb('lr:6', { sub_step: 'long_run' });
    expect(r.done).toBe(true);
    expect((r.newPartial as { long_run_day: number }).long_run_day).toBe(6);
  });

  it('builds a pre-highlighted experience keyboard from the snapshot', async () => {
    const builder = trainingShapeStep.initialKeyboard;
    expect(typeof builder).toBe('function');
    if (typeof builder === 'function') {
      const kb = await builder('a1');
      // experienced-ish snapshot (28 mi/wk) → 'some_training' tier pre-checked
      const serialized = JSON.stringify(kb.inline_keyboard);
      expect(serialized).toContain('✅');
      expect(serialized).toContain('some_training');
    }
  });
});
