import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/jobs/enqueue', () => ({ enqueueJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/server/telegram/checkin/dispatcher', () => ({
  nowInTimezone: vi.fn().mockReturnValue({ date: '2026-05-27', time: '06:30', hour: 6 }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
// The expired-proposal sweep has its own test; stub it here so this suite stays
// focused on enqueue/auto-pause and isn't coupled to the sweep's DB shape.
vi.mock('@/server/telegram/proposals', () => ({
  sweepExpiredProposals: vi.fn().mockResolvedValue(0),
}));
// pause.ts pulls in the heavy bot module; stub it so isInactive stays real but
// the auto-pause notice is a no-op spy we can assert on.
vi.mock('@/server/telegram/bot', () => ({ telegramBot: vi.fn() }));
vi.mock('@/server/telegram/pause', async (importActual) => {
  const actual = await importActual<typeof import('@/server/telegram/pause')>();
  return {
    ...actual,
    sendAutoPauseNotice: vi.fn().mockResolvedValue(undefined),
    sweepCheckBacks: vi.fn().mockResolvedValue(0),
  };
});

import { GET } from './route';
import { supabaseAdmin } from '@/lib/db';
import { enqueueJob } from '@/server/jobs/enqueue';
import { nowInTimezone } from '@/server/telegram/checkin/dispatcher';
import { sendAutoPauseNotice } from '@/server/telegram/pause';

const SECRET = 'test-secret-12345';
const DAY = 86_400_000;

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
    paused_at: null,
    pause_reason: null,
    // Recent by default: the created_at floor keeps a freshly-created athlete
    // active even with no inbound, so the existing enqueue tests still pass.
    created_at: new Date(Date.now() - DAY).toISOString(),
    ...overrides,
  };
}

// Routes from(table) by name: athletes select/update, messages select/insert.
function setupDb({
  athletes,
  recentInbound = [],
}: {
  athletes: unknown[];
  recentInbound?: { athlete_id: string }[];
}) {
  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn().mockReturnValue({ eq: updateEq });
  const insert = vi.fn().mockResolvedValue({ error: null });

  const athletesSelect = vi.fn().mockReturnValue({
    not: vi.fn().mockResolvedValue({ data: athletes, error: null }),
  });
  const messagesSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      gte: vi.fn().mockResolvedValue({ data: recentInbound, error: null }),
    }),
  });

  vi.mocked(supabaseAdmin).mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === 'athletes') return { select: athletesSelect, update };
      if (table === 'messages') return { select: messagesSelect, insert };
      throw new Error(`unexpected table ${table}`);
    }),
  } as unknown as ReturnType<typeof supabaseAdmin>);

  return { update, updateEq, insert };
}

function mockAthletes(rows: unknown[]) {
  return setupDb({ athletes: rows });
}

describe('GET /api/cron/daily-checkin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    delete process.env.AUTO_PAUSE_DRY_RUN;
    // clearAllMocks wipes call history but not implementations; reset the clock
    // mock to the default local-morning hour each test so a per-test override (the
    // local-hour gate cases below) can't leak into the next test.
    vi.mocked(nowInTimezone).mockReturnValue({ date: '2026-05-27', time: '05:00', hour: 5 });
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
    expect(await res.json()).toEqual({ ok: true, skipped: 'no_onboarded_athlete', expiredProposalsCleared: 0, checkBacksNudged: 0 });
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it('happy path: enqueues a daily_checkin job keyed to the local day', async () => {
    mockAthletes([makeAthlete()]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enqueued: 1, paused: [], dryRun: false, expiredProposalsCleared: 0, checkBacksNudged: 0 });
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
    expect(await res.json()).toEqual({ ok: true, enqueued: 3, paused: [], dryRun: false, expiredProposalsCleared: 0, checkBacksNudged: 0 });
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
    expect(await res.json()).toEqual({ ok: true, enqueued: 1, paused: [], dryRun: false, expiredProposalsCleared: 0, checkBacksNudged: 0 });
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledOnce();
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledWith(
      'daily_checkin',
      'daily-real-2026-05-27',
      { athlete_id: 'real' },
    );
  });

  it('skips already-paused athletes', async () => {
    mockAthletes([makeAthlete({ id: 'paused', paused_at: new Date().toISOString(), pause_reason: 'manual' })]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'no_onboarded_athlete', expiredProposalsCleared: 0, checkBacksNudged: 0 });
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it("filters out athletes who haven't completed onboarding", async () => {
    mockAthletes([makeAthlete({ onboarding_state: { step: 3 } })]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'no_onboarded_athlete', expiredProposalsCleared: 0, checkBacksNudged: 0 });
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it('enqueues v3-complete athletes (no `step` field, gated on phase)', async () => {
    mockAthletes([makeAthlete({ id: 'v3-done', onboarding_state: { flow: 'v3', phase: 'complete' } })]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enqueued: 1, paused: [], dryRun: false, expiredProposalsCleared: 0, checkBacksNudged: 0 });
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledWith(
      'daily_checkin',
      'daily-v3-done-2026-05-27',
      { athlete_id: 'v3-done' },
    );
  });

  it('filters out v3 athletes still mid-onboarding (phase !== complete)', async () => {
    mockAthletes([makeAthlete({ onboarding_state: { flow: 'v3', phase: 'intake' } })]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'no_onboarded_athlete', expiredProposalsCleared: 0, checkBacksNudged: 0 });
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it('auto-pauses a silent athlete instead of enqueuing', async () => {
    const silent = makeAthlete({
      id: 'silent',
      created_at: new Date(Date.now() - 30 * DAY).toISOString(),
    });
    const { update, updateEq } = setupDb({ athletes: [silent], recentInbound: [] });
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enqueued: 0, paused: ['silent'], dryRun: false, expiredProposalsCleared: 0, checkBacksNudged: 0 });
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      paused_at: expect.any(String),
      pause_reason: 'auto_inactivity',
    });
    expect(updateEq).toHaveBeenCalledWith('id', 'silent');
    expect(vi.mocked(sendAutoPauseNotice)).toHaveBeenCalledOnce();
  });

  it('keeps a silent athlete active when they have recent inbound', async () => {
    const a = makeAthlete({ id: 'chatty', created_at: new Date(Date.now() - 30 * DAY).toISOString() });
    setupDb({ athletes: [a], recentInbound: [{ athlete_id: 'chatty' }] });
    const res = await GET(authedReq());
    expect(await res.json()).toEqual({ ok: true, enqueued: 1, paused: [], dryRun: false, expiredProposalsCleared: 0, checkBacksNudged: 0 });
    expect(vi.mocked(sendAutoPauseNotice)).not.toHaveBeenCalled();
  });

  it('dry run reports the pause candidate but writes nothing', async () => {
    process.env.AUTO_PAUSE_DRY_RUN = '1';
    const silent = makeAthlete({ id: 'silent', created_at: new Date(Date.now() - 30 * DAY).toISOString() });
    const { update } = setupDb({ athletes: [silent], recentInbound: [] });
    const res = await GET(authedReq());
    expect(await res.json()).toEqual({ ok: true, enqueued: 0, paused: ['silent'], dryRun: true, expiredProposalsCleared: 0, checkBacksNudged: 0 });
    expect(update).not.toHaveBeenCalled();
    expect(vi.mocked(sendAutoPauseNotice)).not.toHaveBeenCalled();
  });

  it('skips when it is not yet the local check-in hour for any athlete', async () => {
    vi.mocked(nowInTimezone).mockReturnValue({ date: '2026-05-27', time: '09:00', hour: 9 });
    mockAthletes([makeAthlete()]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      skipped: 'no_athlete_due_this_hour',
      expiredProposalsCleared: 0,
      checkBacksNudged: 0,
    });
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
  });

  it('enqueues only the athletes for whom it is the local check-in hour this tick', async () => {
    // Same UTC tick, two zones: 5am where the Eastern athlete lives, 2am where
    // the Pacific one does. Only the Eastern athlete is due.
    vi.mocked(nowInTimezone).mockImplementation((tz) =>
      tz === 'America/New_York'
        ? { date: '2026-05-27', time: '05:00', hour: 5 }
        : { date: '2026-05-27', time: '02:00', hour: 2 },
    );
    mockAthletes([
      makeAthlete({ id: 'eastern-due', timezone: 'America/New_York' }),
      makeAthlete({ id: 'pacific-early', timezone: 'America/Los_Angeles' }),
    ]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      enqueued: 1,
      paused: [],
      dryRun: false,
      expiredProposalsCleared: 0,
      checkBacksNudged: 0,
    });
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledOnce();
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledWith(
      'daily_checkin',
      'daily-eastern-due-2026-05-27',
      { athlete_id: 'eastern-due' },
    );
  });
});
