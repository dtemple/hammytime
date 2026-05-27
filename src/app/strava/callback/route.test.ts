import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks — declared before imports that use them
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/state-sign', () => ({ verify: vi.fn() }));
vi.mock('@/server/strava/client', () => ({ exchangeCode: vi.fn() }));
vi.mock('@/lib/crypto', () => ({ encryptToken: vi.fn() }));
vi.mock('@/server/telegram/bot', () => ({ sendAndLog: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import { verify } from '@/lib/state-sign';
import { exchangeCode } from '@/server/strava/client';
import { encryptToken } from '@/lib/crypto';
import { sendAndLog } from '@/server/telegram/bot';
import * as Sentry from '@sentry/nextjs';
import { GET } from './route';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-uuid-1';
const CHAT_ID = '123456789';

const MOCK_TOKENS = {
  access_token: 'access-abc',
  refresh_token: 'refresh-xyz',
  expires_at: Math.floor(Date.now() / 1000) + 21600,
  provider_athlete_id: 'strava-42',
};

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('https://hammytime.example.com/strava/callback');
  const withScope = { scope: 'read,activity:read_all', ...params };
  for (const [k, v] of Object.entries(withScope)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

function makeDb(opts: { athleteRow?: object | null; upsertError?: string } = {}) {
  const { athleteRow = { id: ATHLETE_ID, telegram_chat_id: CHAT_ID }, upsertError } = opts;

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'oauth_tokens') {
        return {
          upsert: vi
            .fn()
            .mockResolvedValue({ error: upsertError ? { message: upsertError } : null }),
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: state verifies OK, tokens exchange OK, encrypt produces placeholder
  (verify as AnyMock).mockReturnValue({ athlete_id: ATHLETE_ID, iat: Date.now(), nonce: 'abc' });
  (exchangeCode as AnyMock).mockResolvedValue(MOCK_TOKENS);
  (encryptToken as AnyMock).mockResolvedValue('encrypted-token');
  (sendAndLog as AnyMock).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('GET /strava/callback — happy path', () => {
  it('redirects to /strava/connected and sends Telegram confirmation', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb());
    const req = makeRequest({ code: 'auth-code', state: 'valid-state' });

    const res = await GET(req);

    // Browser gets a redirect to the connected page
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/strava/connected');

    // Telegram confirmation sent to athlete
    expect(sendAndLog).toHaveBeenCalledOnce();
    const [, , text] = (sendAndLog as AnyMock).mock.calls[0] as [string, string, string];
    expect(text).toContain('Strava connected');
    expect(text).toContain('/checkin');
  });

  it('still redirects when athlete has no telegram_chat_id (no sendAndLog call)', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({ athleteRow: { id: ATHLETE_ID, telegram_chat_id: null } }),
    );
    const req = makeRequest({ code: 'auth-code', state: 'valid-state' });

    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(sendAndLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error paths (before Telegram confirmation step)
// ---------------------------------------------------------------------------

describe('GET /strava/callback — pre-upsert errors', () => {
  it('returns 400 when code is missing', async () => {
    const req = makeRequest({ state: 'valid-state' });

    const res = await GET(req);

    expect(res.status).toBe(400);
    expect(sendAndLog).not.toHaveBeenCalled();
  });

  it('returns 400 when state signature is invalid', async () => {
    (verify as AnyMock).mockImplementation(() => {
      throw new Error('signature mismatch');
    });
    const req = makeRequest({ code: 'auth-code', state: 'bad-state' });

    const res = await GET(req);

    expect(res.status).toBe(400);
    expect(sendAndLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sendAndLog failure — callback must NOT throw
// ---------------------------------------------------------------------------

describe('GET /strava/callback — sendAndLog failure is non-fatal', () => {
  it('redirects successfully even when sendAndLog throws', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb());
    (sendAndLog as AnyMock).mockRejectedValue(new Error('Telegram API unavailable'));
    const req = makeRequest({ code: 'auth-code', state: 'valid-state' });

    const res = await GET(req);

    // Still redirects — the error was swallowed
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/strava/connected');

    // Error captured in Sentry
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });
});
