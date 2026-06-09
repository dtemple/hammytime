import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/jobs/enqueue', () => ({ enqueueJob: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import { enqueueJob } from '@/server/jobs/enqueue';
import { GET } from './route';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const SECRET = 'cron-secret-1';

function makeRequest(auth?: string): Request {
  return new Request('https://daybreak.run/api/cron/calendar-reconcile', {
    headers: auth ? { authorization: auth } : {},
  });
}

function makeDb(rows: { athlete_id: string }[] | null, errMsg?: string) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: rows,
          error: errMsg ? { message: errMsg } : null,
        }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  (enqueueJob as AnyMock).mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/calendar-reconcile', () => {
  it('401s without the cron secret', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('401s with a wrong secret', async () => {
    const res = await GET(makeRequest('Bearer nope'));
    expect(res.status).toBe(401);
  });

  it('skips cleanly when no athlete has Google connected', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb([]));
    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'no_connected_athletes' });
  });

  it('enqueues one nightly calendar_sync per connected athlete with a per-day key', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb([{ athlete_id: 'ath-1' }, { athlete_id: 'ath-2' }]),
    );

    const res = await GET(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enqueued: 2 });
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(enqueueJob).toHaveBeenCalledWith(
      'calendar_sync',
      expect.stringMatching(/^calsync-ath-1-nightly-\d{8}$/),
      { athlete_id: 'ath-1', reason: 'nightly' },
    );
  });

  it('500s when the connections query fails', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb(null, 'db down'));
    const res = await GET(makeRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
  });
});
