import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/jobs/enqueue', () => ({ enqueueJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/server/telegram/checkin/dispatcher', () => ({
  nowInTimezone: vi.fn().mockReturnValue({ date: '2026-05-27', time: '06:30' }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { GET } from './route';
import { supabaseAdmin } from '@/lib/db';
import { enqueueJob } from '@/server/jobs/enqueue';

const SECRET = 'test-secret-12345';

function makeReq(headers: Record<string, string> = {}) {
  return new Request('https://example.com/api/cron/daily-checkin', { headers });
}

function authedReq() {
  return makeReq({ authorization: `Bearer ${SECRET}` });
}

function makeAthlete(overrides: Record<string, unknown> = {}) {
  return {
    id: 'athlete-1',
    telegram_chat_id: '42',
    onboarding_state: { step: 7 },
    checkin_state: {},
    timezone: 'America/Los_Angeles',
    ...overrides,
  };
}

function mockAthletes(rows: unknown[], error: { message: string } | null = null) {
  const notMock = vi.fn().mockResolvedValue({ data: rows, error });
  const selectMock = vi.fn().mockReturnValue({ not: notMock });
  vi.mocked(supabaseAdmin).mockReturnValue({
    from: vi.fn().mockReturnValue({ select: selectMock }),
  } as unknown as ReturnType<typeof supabaseAdmin>);
}

describe('GET /api/cron/daily-checkin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
  });

  it('rejects when Authorization header is missing', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it('rejects when bearer token is wrong', async () => {
    const res = await GET(makeReq({ authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it('rejects when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeReq({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(401);
  });

  it('skips when no onboarded athlete exists', async () => {
    mockAthletes([]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'no_onboarded_athlete' });
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it('happy path: enqueues a daily_checkin job keyed to the local day', async () => {
    mockAthletes([makeAthlete()]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enqueued: 1 });
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledWith(
      'daily_checkin',
      'daily-athlete-1-2026-05-27',
      { athlete_id: 'athlete-1' },
    );
  });

  it('enqueues one job per onboarded athlete', async () => {
    mockAthletes([
      makeAthlete({ id: 'athlete-1' }),
      makeAthlete({ id: 'athlete-2' }),
      makeAthlete({ id: 'athlete-3' }),
    ]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enqueued: 3 });
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledWith(
      'daily_checkin',
      'daily-athlete-2-2026-05-27',
      { athlete_id: 'athlete-2' },
    );
  });

  it('skips test athletes (negative chat id) and enqueues the rest', async () => {
    mockAthletes([
      makeAthlete({ id: 'real', telegram_chat_id: '42' }),
      makeAthlete({ id: 'test', telegram_chat_id: '-1001234' }),
    ]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enqueued: 1 });
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledOnce();
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledWith(
      'daily_checkin',
      'daily-real-2026-05-27',
      { athlete_id: 'real' },
    );
  });

  it("filters out athletes who haven't completed onboarding", async () => {
    mockAthletes([makeAthlete({ onboarding_state: { step: 3 } })]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'no_onboarded_athlete' });
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });
});
