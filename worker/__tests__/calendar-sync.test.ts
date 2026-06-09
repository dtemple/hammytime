import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/google/sync', () => ({ reconcileCalendar: vi.fn() }));
vi.mock('../send', () => ({ sendReply: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import { GoogleAuthRevokedError } from '@/server/google/client';
import { reconcileCalendar } from '@/server/google/sync';
import { sendReply } from '../send';
import { runCalendarSync } from '../jobs/calendar-sync';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'ath-1';

function makeDb() {
  const eq2 = vi.fn().mockResolvedValue({ error: null });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const deleteMock = vi.fn().mockReturnValue({ eq: eq1 });
  return {
    from: vi.fn().mockReturnValue({ delete: deleteMock }),
    _deleteMock: deleteMock,
    _eq1: eq1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (sendReply as AnyMock).mockResolvedValue(undefined);
});

describe('runCalendarSync', () => {
  it('completes quietly on a successful reconcile', async () => {
    (reconcileCalendar as AnyMock).mockResolvedValue({
      imported: 2,
      patched: 1,
      deleted: 0,
      skipped: 150,
    });
    await expect(runCalendarSync(ATHLETE_ID)).resolves.toBeUndefined();
    expect(supabaseAdmin).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('tears down the connection and messages the athlete when the grant is revoked', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    (reconcileCalendar as AnyMock).mockRejectedValue(new GoogleAuthRevokedError('revoked'));

    // Resolves (terminal) — the job must complete, not retry.
    await expect(runCalendarSync(ATHLETE_ID)).resolves.toBeUndefined();

    expect(db.from).toHaveBeenCalledWith('oauth_tokens');
    expect(db._eq1).toHaveBeenCalledWith('athlete_id', ATHLETE_ID);
    expect(sendReply).toHaveBeenCalledWith(ATHLETE_ID, expect.stringContaining('/calendar'));
  });

  it('rethrows other errors into the job-queue retry machinery', async () => {
    (reconcileCalendar as AnyMock).mockRejectedValue(new Error('events.list failed (500)'));
    await expect(runCalendarSync(ATHLETE_ID)).rejects.toThrow(/events.list/);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('still completes the revoked teardown when the Telegram message fails', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb());
    (reconcileCalendar as AnyMock).mockRejectedValue(new GoogleAuthRevokedError('revoked'));
    (sendReply as AnyMock).mockRejectedValue(new Error('tg down'));
    await expect(runCalendarSync(ATHLETE_ID)).resolves.toBeUndefined();
  });
});
