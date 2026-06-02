import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/agent/race-lookup', () => ({ lookupRace: vi.fn() }));

import { lookupRace } from '@/server/agent/race-lookup';
import { goalSetupStep } from '../steps/01-goal-setup';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const cb = (data: string, partial: Record<string, unknown> = {}) =>
  goalSetupStep.handleCallback!(data, partial, 'a1');
const msg = (text: string, partial: Record<string, unknown> = {}) =>
  goalSetupStep.handleMessage!(text, partial, 'a1');

beforeEach(() => vi.clearAllMocks());

describe('goal-setup — A2 goal choice', () => {
  it('day-to-day is a no-op alert that does not advance', async () => {
    const r = await cb('goal:daytoday');
    expect(r.done).toBe(false);
    if (!r.done) expect(r.alertText).toContain('coming soon');
  });

  it('race choice advances to the race-or-not screen', async () => {
    const r = await cb('goal:race');
    expect(r.done).toBe(false);
    if (!r.done) {
      expect((r.newPartial as { sub_step: string }).sub_step).toBe('race_choice');
      expect(r.replyMarkup).toBeDefined();
    }
  });
});

describe('goal-setup — A4b no-race branch (intended)', () => {
  it('distance then timeframe completes with a placeholder target_date', async () => {
    const afterNone = await cb('race:none', { sub_step: 'race_choice' });
    const afterDist = await cb('dist:half', afterNone.newPartial);
    expect((afterDist.newPartial as { goal_distance: string }).goal_distance).toBe('half');

    const done = await cb('tf:12', afterDist.newPartial);
    expect(done.done).toBe(true);
    const p = done.newPartial as { goal_distance: string; target_date: string | null };
    expect(p.goal_distance).toBe('half');
    expect(p.target_date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // today + 12 weeks
  });

  it('no-timeline leaves target_date null', async () => {
    const done = await cb('tf:none', { sub_step: 'race_choice', goal_distance: 'keep_fit' });
    expect(done.done).toBe(true);
    expect((done.newPartial as { target_date: string | null }).target_date).toBeNull();
  });
});

describe('goal-setup — A4 named race (committed)', () => {
  it('a high-confidence lookup asks to confirm, then yes completes', async () => {
    (lookupRace as AnyMock).mockResolvedValue({
      ok: true,
      found: {
        canonical_name: 'CIM',
        date: '2026-12-06',
        distance_mi: 26.2,
        elevation_ft: 300,
        terrain: 'road',
        source_url: null,
        confidence: 'high',
      },
    });

    const afterName = await msg('CIM', { sub_step: 'race_name' });
    expect((afterName.newPartial as { sub_step: string }).sub_step).toBe('race_confirm');

    const done = await msg('yes', afterName.newPartial);
    expect(done.done).toBe(true);
    const race = (done.newPartial as { goal_race: { name: string; distance_mi: number } }).goal_race;
    expect(race.name).toBe('CIM');
    expect(race.distance_mi).toBe(26.2);
  });

  it('a not-found lookup falls back to manual date + distance', async () => {
    (lookupRace as AnyMock).mockResolvedValue({ ok: false, reason: 'not_found' });

    const afterName = await msg('Some Local 10K', { sub_step: 'race_name' });
    expect((afterName.newPartial as { sub_step: string }).sub_step).toBe('race_manual_date');

    const afterDate = await msg('2026-10-04', afterName.newPartial);
    expect((afterDate.newPartial as { sub_step: string }).sub_step).toBe('race_manual_distance');

    const done = await msg('10k', afterDate.newPartial);
    expect(done.done).toBe(true);
    const race = (done.newPartial as { goal_race: { date: string; distance_mi: number } }).goal_race;
    expect(race.date).toBe('2026-10-04');
    expect(race.distance_mi).toBeCloseTo(6.21, 1);
  });
});

describe('goal-setup — typed message on a button screen', () => {
  it('nudges the athlete to tap', async () => {
    const r = await msg('hello', { sub_step: 'goal_choice' });
    expect(r.done).toBe(false);
    if (!r.done) expect(r.reply).toContain('button');
  });
});
