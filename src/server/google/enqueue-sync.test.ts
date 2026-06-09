import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/jobs/enqueue', () => ({ enqueueJob: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import { enqueueJob } from '@/server/jobs/enqueue';
import { enqueueCalendarSyncIfConnected } from './enqueue-sync';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-1';

function makeDb(row: object | null) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (enqueueJob as AnyMock).mockResolvedValue(undefined);
});

describe('enqueueCalendarSyncIfConnected', () => {
  it('does nothing for an athlete without a Google connection', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb(null));
    await enqueueCalendarSyncIfConnected(ATHLETE_ID, 'promotion');
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('enqueues a calendar_sync job with reason for a connected athlete', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ id: 'tok-1' }));
    await enqueueCalendarSyncIfConnected(ATHLETE_ID, 'promotion');
    expect(enqueueJob).toHaveBeenCalledWith(
      'calendar_sync',
      expect.stringMatching(new RegExp(`^calsync-${ATHLETE_ID}-promotion-\\d+$`)),
      { athlete_id: ATHLETE_ID, reason: 'promotion' },
    );
  });

  it('keys on the version id when provided', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ id: 'tok-1' }));
    await enqueueCalendarSyncIfConnected(ATHLETE_ID, 'plan_gen', 'v-42');
    const key = (enqueueJob as AnyMock).mock.calls[0][1];
    expect(key).toMatch(new RegExp(`^calsync-${ATHLETE_ID}-v-42-\\d+$`));
  });

  it('never throws — a failed enqueue is logged and swallowed', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ id: 'tok-1' }));
    (enqueueJob as AnyMock).mockRejectedValue(new Error('db down'));
    await expect(enqueueCalendarSyncIfConnected(ATHLETE_ID, 'promotion')).resolves.toBeUndefined();
  });
});
