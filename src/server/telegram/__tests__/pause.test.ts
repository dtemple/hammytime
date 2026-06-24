import { describe, it, expect } from 'vitest';

// pause.ts imports telegramBot from ./bot and supabaseAdmin from @/lib/db at the
// top level; isInactive uses neither, so stub both to keep this a pure unit test.
import { vi } from 'vitest';
vi.mock('../bot', () => ({ telegramBot: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));

import {
  isInactive,
  daysUntilAutoPause,
  INACTIVITY_WINDOW_DAYS,
  sweepCheckBacks,
  CHECK_BACK_NUDGE,
  pauseAthleteManual,
  resumeAthlete,
  clearAutoInactivityPause,
} from '../pause';
import { supabaseAdmin } from '@/lib/db';
import { telegramBot } from '../bot';
import type { Database } from '@/lib/db-types';

type AthleteRow = Database['public']['Tables']['athletes']['Row'];

const NOW = Date.parse('2026-06-14T12:00:00.000Z');
const cutoffMs = NOW - INACTIVITY_WINDOW_DAYS * 86_400_000;

function athlete(id: string, createdAtMs: number) {
  return { id, created_at: new Date(createdAtMs).toISOString() };
}

describe('isInactive', () => {
  it('keeps an athlete with inbound inside the window active', () => {
    const a = athlete('a1', NOW - 30 * 86_400_000); // created long ago…
    expect(isInactive(a, new Set(['a1']), cutoffMs)).toBe(false); // …but recently active
  });

  it('pauses an athlete created before the window with no recent inbound', () => {
    const a = athlete('a2', NOW - 30 * 86_400_000);
    expect(isInactive(a, new Set(), cutoffMs)).toBe(true);
  });

  it('does not pause a freshly-onboarded athlete with no inbound yet (created_at floor)', () => {
    const a = athlete('a3', NOW - 3 * 86_400_000); // created 3 days ago, never chatted
    expect(isInactive(a, new Set(), cutoffMs)).toBe(false);
  });

  it('treats activity as winning even when created before the window', () => {
    const a = athlete('a4', NOW - 90 * 86_400_000);
    expect(isInactive(a, new Set(['a4']), cutoffMs)).toBe(false);
  });

  it('pauses exactly at the boundary (created before cutoff, silent)', () => {
    const a = athlete('a5', cutoffMs - 1);
    expect(isInactive(a, new Set(), cutoffMs)).toBe(true);
  });

  it('keeps an athlete created exactly at the cutoff active', () => {
    const a = athlete('a6', cutoffMs);
    expect(isInactive(a, new Set(), cutoffMs)).toBe(false);
  });
});

describe('daysUntilAutoPause', () => {
  const created = NOW - 90 * 86_400_000; // long ago, so last-inbound is the driver

  it('returns the full window for an athlete who just messaged', () => {
    expect(
      daysUntilAutoPause({ created_at: new Date(created).toISOString() }, NOW, NOW),
    ).toBeCloseTo(INACTIVITY_WINDOW_DAYS);
  });

  it('counts down from the last inbound', () => {
    const twoDaysAgo = NOW - 2 * 86_400_000;
    expect(
      daysUntilAutoPause({ created_at: new Date(created).toISOString() }, twoDaysAgo, NOW),
    ).toBeCloseTo(INACTIVITY_WINDOW_DAYS - 2);
  });

  it('falls back to the created_at floor when there is no inbound in the window', () => {
    const createdTwoDaysAgo = NOW - 2 * 86_400_000;
    expect(
      daysUntilAutoPause({ created_at: new Date(createdTwoDaysAgo).toISOString() }, null, NOW),
    ).toBeCloseTo(INACTIVITY_WINDOW_DAYS - 2);
  });

  it('goes non-positive once an athlete is past due', () => {
    const createdSixDaysAgo = NOW - 6 * 86_400_000;
    expect(
      daysUntilAutoPause({ created_at: new Date(createdSixDaysAgo).toISOString() }, null, NOW),
    ).toBeLessThanOrEqual(0);
  });

  it('lets a recent inbound win over an old creation date', () => {
    const justNow = NOW - 60 * 60 * 1000; // an hour ago
    expect(
      daysUntilAutoPause({ created_at: new Date(created).toISOString() }, justNow, NOW),
    ).toBeGreaterThan(INACTIVITY_WINDOW_DAYS - 1);
  });
});

// --- v4 / V4-W2: the one-shot off-ramp check-back nudge ---

interface SweepRow {
  id: string;
  telegram_chat_id: string | null;
  check_back_at: string;
}

/** Build a supabaseAdmin stub serving `rows` from the due query and recording the
 *  writes the sweep makes. */
function stubSupabaseForSweep(rows: SweepRow[]) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const inserts: Array<Record<string, unknown>> = [];
  vi.mocked(supabaseAdmin).mockReturnValue({
    from: () => ({
      select: () => ({
        not: () => ({ lte: () => Promise.resolve({ data: rows, error: null }) }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          updates.push({ id, patch });
          return Promise.resolve({ error: null });
        },
      }),
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        return Promise.resolve({ error: null });
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return { updates, inserts };
}

describe('sweepCheckBacks', () => {
  it('nudges a due athlete, logs the message, and nulls the date on success', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(telegramBot).mockReturnValue({ api: { sendMessage } } as any);
    const { updates, inserts } = stubSupabaseForSweep([
      { id: 'd1', telegram_chat_id: '111', check_back_at: '2020-01-01T00:00:00Z' },
    ]);

    const sent = await sweepCheckBacks();

    expect(sent).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith('111', CHECK_BACK_NUDGE, {});
    expect(inserts).toHaveLength(1); // the outbound message is logged
    expect(updates).toEqual([{ id: 'd1', patch: { check_back_at: null } }]); // nulled
  });

  it('clears the date but sends nothing for an athlete with no chat id', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(telegramBot).mockReturnValue({ api: { sendMessage } } as any);
    const { updates, inserts } = stubSupabaseForSweep([
      { id: 'd2', telegram_chat_id: null, check_back_at: '2020-01-01T00:00:00Z' },
    ]);

    const sent = await sweepCheckBacks();

    expect(sent).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(updates).toEqual([{ id: 'd2', patch: { check_back_at: null } }]);
  });

  it('leaves the date set when the send fails, so the next tick retries', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('telegram down'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(telegramBot).mockReturnValue({ api: { sendMessage } } as any);
    const { updates } = stubSupabaseForSweep([
      { id: 'd3', telegram_chat_id: '222', check_back_at: '2020-01-01T00:00:00Z' },
    ]);

    const sent = await sweepCheckBacks();

    expect(sent).toBe(0);
    expect(updates).toHaveLength(0); // never nulled → retried next tick
  });
});

// --- §10: manual /pause + /resume ---

/** supabaseAdmin stub that records every `.from(...).update(patch).eq('id', id)`
 *  the helper makes, with no real DB. */
function stubSupabaseForUpdate() {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  vi.mocked(supabaseAdmin).mockReturnValue({
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          updates.push({ id, patch });
          return Promise.resolve({ error: null });
        },
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return updates;
}

describe('pauseAthleteManual', () => {
  it('sets paused_at + pause_reason=manual for an active athlete', async () => {
    const updates = stubSupabaseForUpdate();
    const result = await pauseAthleteManual({ id: 'm1', paused_at: null });
    expect(result).toBe('paused');
    expect(updates).toEqual([
      { id: 'm1', patch: { paused_at: expect.any(String), pause_reason: 'manual' } },
    ]);
  });

  it('is idempotent — an already-paused athlete writes nothing', async () => {
    const updates = stubSupabaseForUpdate();
    const result = await pauseAthleteManual({ id: 'm2', paused_at: '2026-06-10T00:00:00Z' });
    expect(result).toBe('already_paused');
    expect(updates).toHaveLength(0);
  });
});

describe('resumeAthlete', () => {
  it('clears the pause and returns resumed (delivery is the caller’s job)', async () => {
    const updates = stubSupabaseForUpdate();
    const result = await resumeAthlete({ id: 'r1', paused_at: '2026-06-10T00:00:00Z' });
    expect(result).toBe('resumed');
    expect(updates).toEqual([{ id: 'r1', patch: { paused_at: null, pause_reason: null } }]);
  });

  it('is idempotent — a not-paused athlete writes nothing', async () => {
    const updates = stubSupabaseForUpdate();
    const result = await resumeAthlete({ id: 'r2', paused_at: null });
    expect(result).toBe('not_paused');
    expect(updates).toHaveLength(0);
  });
});

describe('clearAutoInactivityPause leaves a manual pause intact', () => {
  it('returns false and writes nothing for a manual pause', async () => {
    const updates = stubSupabaseForUpdate();
    const cleared = await clearAutoInactivityPause({
      id: 'p1',
      paused_at: '2026-06-10T00:00:00Z',
      pause_reason: 'manual',
    } as AthleteRow);
    expect(cleared).toBe(false);
    expect(updates).toHaveLength(0); // a manual pause survives an inbound (§10.5)
  });

  it('clears an auto_inactivity pause', async () => {
    const updates = stubSupabaseForUpdate();
    const cleared = await clearAutoInactivityPause({
      id: 'p2',
      paused_at: '2026-06-10T00:00:00Z',
      pause_reason: 'auto_inactivity',
    } as AthleteRow);
    expect(cleared).toBe(true);
    expect(updates).toEqual([{ id: 'p2', patch: { paused_at: null, pause_reason: null } }]);
  });
});
