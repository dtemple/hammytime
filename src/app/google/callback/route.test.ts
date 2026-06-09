import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/state-sign', () => ({ verify: vi.fn() }));
vi.mock('@/server/google/client', () => ({
  exchangeCode: vi.fn(),
  CALENDAR_SCOPE: 'https://www.googleapis.com/auth/calendar.app.created',
}));
vi.mock('@/server/google/calendar-api', () => ({ insertCalendar: vi.fn() }));
vi.mock('@/lib/crypto', () => ({ encryptToken: vi.fn() }));
vi.mock('@/server/telegram/bot', () => ({ sendAndLog: vi.fn() }));
vi.mock('@/server/jobs/enqueue', () => ({ enqueueJob: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import { verify } from '@/lib/state-sign';
import { exchangeCode } from '@/server/google/client';
import { insertCalendar } from '@/server/google/calendar-api';
import { encryptToken } from '@/lib/crypto';
import { sendAndLog } from '@/server/telegram/bot';
import { enqueueJob } from '@/server/jobs/enqueue';
import { GET } from './route';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-uuid-1';
const CHAT_ID = '123456789';
const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

const MOCK_TOKENS = {
  access_token: 'access-abc',
  refresh_token: 'refresh-xyz',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  scope: SCOPE,
};

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('https://daybreak.run/google/callback');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

function makeDb(
  opts: {
    athleteRow?: object | null;
    existingTokenRow?: object | null;
    upsertError?: string;
  } = {},
) {
  const {
    athleteRow = { id: ATHLETE_ID, timezone: 'America/Los_Angeles', telegram_chat_id: CHAT_ID },
    existingTokenRow = null,
    upsertError,
  } = opts;

  const upsertMock = vi
    .fn()
    .mockResolvedValue({ error: upsertError ? { message: upsertError } : null });

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'oauth_tokens') {
        return {
          upsert: upsertMock,
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: existingTokenRow, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'athletes') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: athleteRow, error: null }),
            }),
          }),
        };
      }
      return {};
    }),
    _upsertMock: upsertMock,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (verify as AnyMock).mockReturnValue({ athlete_id: ATHLETE_ID, iat: Date.now(), nonce: 'abc' });
  (exchangeCode as AnyMock).mockResolvedValue(MOCK_TOKENS);
  (insertCalendar as AnyMock).mockResolvedValue({ id: 'daybreak-cal-1' });
  (encryptToken as AnyMock).mockImplementation(async (p: string) => `enc(${p})`);
  (sendAndLog as AnyMock).mockResolvedValue(undefined);
  (enqueueJob as AnyMock).mockResolvedValue(undefined);
});

describe('GET /google/callback — happy path', () => {
  it('creates the Daybreak calendar, stores the row, enqueues the first sync, confirms in Telegram', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    const res = await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://daybreak.run/google/connected');

    expect(insertCalendar).toHaveBeenCalledWith('access-abc', {
      summary: 'Daybreak — training',
      timeZone: 'America/Los_Angeles',
    });

    const upserted = db._upsertMock.mock.calls[0]![0];
    expect(upserted.provider).toBe('google_calendar');
    expect(upserted.provider_calendar_id).toBe('daybreak-cal-1');
    expect(upserted.access_token_enc).toBe('enc(access-abc)');
    expect(upserted.refresh_token_enc).toBe('enc(refresh-xyz)');

    expect(enqueueJob).toHaveBeenCalledWith(
      'calendar_sync',
      expect.stringMatching(new RegExp(`^calsync-${ATHLETE_ID}-connect-`)),
      { athlete_id: ATHLETE_ID, reason: 'connect' },
    );
    expect(sendAndLog).toHaveBeenCalledWith(ATHLETE_ID, CHAT_ID, expect.stringContaining('connected'));
  });

  it('reuses an existing Daybreak calendar on reconnect instead of creating a duplicate', async () => {
    const db = makeDb({ existingTokenRow: { provider_calendar_id: 'old-cal' } });
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    await GET(makeRequest({ code: 'auth-code', state: 'valid-state' }));

    expect(insertCalendar).not.toHaveBeenCalled();
    expect(db._upsertMock.mock.calls[0]![0].provider_calendar_id).toBe('old-cal');
  });
});

describe('GET /google/callback — rejections', () => {
  it('redirects to the result page when the user cancels consent', async () => {
    const res = await GET(makeRequest({ error: 'access_denied' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/google/connected?error=access_denied');
  });

  it('400s on missing code or state', async () => {
    const res = await GET(makeRequest({ code: 'only-code' }));
    expect(res.status).toBe(400);
  });

  it('400s on an invalid state token', async () => {
    (verify as AnyMock).mockImplementation(() => {
      throw new Error('bad signature');
    });
    const res = await GET(makeRequest({ code: 'c', state: 'tampered' }));
    expect(res.status).toBe(400);
  });

  it('redirects with insufficient_scope when the calendar scope was unticked', async () => {
    (exchangeCode as AnyMock).mockResolvedValue({ ...MOCK_TOKENS, scope: 'openid email' });
    const res = await GET(makeRequest({ code: 'c', state: 's' }));
    expect(res.headers.get('location')).toContain('error=insufficient_scope');
  });

  it('redirects with no_refresh_token when Google omits the refresh token', async () => {
    (exchangeCode as AnyMock).mockResolvedValue({ ...MOCK_TOKENS, refresh_token: null });
    const res = await GET(makeRequest({ code: 'c', state: 's' }));
    expect(res.headers.get('location')).toContain('error=no_refresh_token');
  });

  it('500s when the token upsert fails', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ upsertError: 'permission denied' }));
    const res = await GET(makeRequest({ code: 'c', state: 's' }));
    expect(res.status).toBe(500);
  });

  it('still redirects when the Telegram confirmation fails', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb());
    (sendAndLog as AnyMock).mockRejectedValue(new Error('tg down'));
    const res = await GET(makeRequest({ code: 'c', state: 's' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://daybreak.run/google/connected');
  });
});
