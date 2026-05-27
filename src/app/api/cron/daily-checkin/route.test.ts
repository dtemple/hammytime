import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/telegram/bot', () => ({ sendAndLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/server/telegram/checkin/wellness-log', () => ({
  wellnessLogContains: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/server/telegram/checkin/dispatcher', () => ({
  writeCheckinState: vi.fn().mockResolvedValue(undefined),
  nowInTimezone: vi.fn().mockReturnValue({ date: '2026-05-27', time: '06:30' }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { GET } from './route';
import { supabaseAdmin } from '@/lib/db';
import { sendAndLog } from '@/server/telegram/bot';
import { wellnessLogContains } from '@/server/telegram/checkin/wellness-log';
import { writeCheckinState } from '@/server/telegram/checkin/dispatcher';
import { READINESS_PROMPT } from '@/server/telegram/checkin/wellness';

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
    vi.mocked(wellnessLogContains).mockResolvedValue(false);
  });

  it('rejects when Authorization header is missing', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(vi.mocked(sendAndLog)).not.toHaveBeenCalled();
  });

  it('rejects when bearer token is wrong', async () => {
    const res = await GET(makeReq({ authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect(vi.mocked(sendAndLog)).not.toHaveBeenCalled();
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
    expect(vi.mocked(sendAndLog)).not.toHaveBeenCalled();
  });

  it('skips when athlete is mid-checkin', async () => {
    mockAthletes([makeAthlete({ checkin_state: { sub_step: 'awaiting_readiness', partial: {} } })]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'mid_checkin' });
    expect(vi.mocked(sendAndLog)).not.toHaveBeenCalled();
  });

  it("skips when wellness log already has today's entry", async () => {
    mockAthletes([makeAthlete()]);
    vi.mocked(wellnessLogContains).mockResolvedValue(true);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'already_checked_in_today' });
    expect(vi.mocked(sendAndLog)).not.toHaveBeenCalled();
  });

  it('happy path: sets state, sends readiness, returns fired', async () => {
    mockAthletes([makeAthlete()]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 'athlete-1' });
    expect(vi.mocked(writeCheckinState)).toHaveBeenCalledWith('athlete-1', {
      sub_step: 'awaiting_readiness',
      partial: {},
    });
    expect(vi.mocked(sendAndLog)).toHaveBeenCalledWith('athlete-1', '42', READINESS_PROMPT);
  });

  it("filters out athletes who haven't completed onboarding", async () => {
    mockAthletes([makeAthlete({ onboarding_state: { step: 3 } })]);
    const res = await GET(authedReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: 'no_onboarded_athlete' });
  });
});
