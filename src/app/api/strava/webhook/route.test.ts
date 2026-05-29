import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/strava/disconnect', () => ({ disconnectStrava: vi.fn() }));
vi.mock('@/server/telegram/bot', () => ({ sendAndLog: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import { disconnectStrava } from '@/server/strava/disconnect';
import { sendAndLog } from '@/server/telegram/bot';
import * as Sentry from '@sentry/nextjs';
import { GET, POST } from './route';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const VERIFY_TOKEN = 'verify-secret-123';
const ATHLETE_ID = 'athlete-uuid-1';
const CHAT_ID = '987654321';

function getReq(params: Record<string, string>): NextRequest {
  const url = new URL('https://daybreak.run/api/strava/webhook');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest('https://daybreak.run/api/strava/webhook', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

// db mock: oauth_tokens lookup by provider_athlete_id, athletes lookup by id
function makeDb(opts: { tokenRow?: object | null; athleteRow?: object | null } = {}) {
  const {
    tokenRow = { athlete_id: ATHLETE_ID },
    athleteRow = { id: ATHLETE_ID, telegram_chat_id: CHAT_ID },
  } = opts;
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'oauth_tokens') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: tokenRow, error: null }),
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRAVA_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
  delete process.env.STRAVA_SUBSCRIPTION_ID;
  (disconnectStrava as AnyMock).mockResolvedValue({ hadConnection: true, revoked: false });
  (sendAndLog as AnyMock).mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;
  delete process.env.STRAVA_SUBSCRIPTION_ID;
});

// ---------------------------------------------------------------------------
// GET — subscription validation handshake
// ---------------------------------------------------------------------------

describe('GET /api/strava/webhook — subscription validation', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const res = await GET(
      getReq({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'challenge-abc',
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ 'hub.challenge': 'challenge-abc' });
  });

  it('returns 403 when the verify token does not match', async () => {
    const res = await GET(
      getReq({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'challenge-abc',
      }),
    );

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST — deauthorization event
// ---------------------------------------------------------------------------

describe('POST /api/strava/webhook — deauthorization', () => {
  it('deletes the token and notifies the athlete on athlete deauth', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb());

    const res = await POST(
      postReq({
        object_type: 'athlete',
        object_id: 42,
        aspect_type: 'update',
        owner_id: 42,
        updates: { authorized: 'false' },
      }),
    );

    expect(res.status).toBe(200);
    expect(disconnectStrava).toHaveBeenCalledWith(ATHLETE_ID, { revokeOnStrava: false });
    expect(sendAndLog).toHaveBeenCalledOnce();
    const [athleteArg, chatArg] = (sendAndLog as AnyMock).mock.calls[0] as [string, string, string];
    expect(athleteArg).toBe(ATHLETE_ID);
    expect(chatArg).toBe(CHAT_ID);
  });

  it('is a no-op when no token row matches the owner_id', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ tokenRow: null }));

    const res = await POST(
      postReq({
        object_type: 'athlete',
        owner_id: 99,
        updates: { authorized: 'false' },
      }),
    );

    expect(res.status).toBe(200);
    expect(disconnectStrava).not.toHaveBeenCalled();
    expect(sendAndLog).not.toHaveBeenCalled();
  });

  it('does not notify when the athlete has no telegram_chat_id', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({ athleteRow: { id: ATHLETE_ID, telegram_chat_id: null } }),
    );

    const res = await POST(
      postReq({ object_type: 'athlete', owner_id: 42, updates: { authorized: 'false' } }),
    );

    expect(res.status).toBe(200);
    expect(disconnectStrava).toHaveBeenCalledOnce();
    expect(sendAndLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST — irrelevant events are no-ops, always 200
// ---------------------------------------------------------------------------

describe('POST /api/strava/webhook — irrelevant events', () => {
  it('ignores activity create events (nothing stored)', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb());

    const res = await POST(
      postReq({
        object_type: 'activity',
        object_id: 1360128428,
        aspect_type: 'create',
        owner_id: 42,
      }),
    );

    expect(res.status).toBe(200);
    expect(disconnectStrava).not.toHaveBeenCalled();
  });

  it('ignores athlete events that are not deauthorization', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb());

    const res = await POST(
      postReq({ object_type: 'athlete', owner_id: 42, updates: { authorized: 'true' } }),
    );

    expect(res.status).toBe(200);
    expect(disconnectStrava).not.toHaveBeenCalled();
  });

  it('still returns 200 when handling throws (Sentry captures)', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb());
    (disconnectStrava as AnyMock).mockRejectedValue(new Error('db down'));

    const res = await POST(
      postReq({ object_type: 'athlete', owner_id: 42, updates: { authorized: 'false' } }),
    );

    expect(res.status).toBe(200);
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('ignores events from a different subscription_id when one is configured', async () => {
    process.env.STRAVA_SUBSCRIPTION_ID = '120475';
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb());

    const res = await POST(
      postReq({
        object_type: 'athlete',
        owner_id: 42,
        subscription_id: 999999,
        updates: { authorized: 'false' },
      }),
    );

    expect(res.status).toBe(200);
    expect(disconnectStrava).not.toHaveBeenCalled();
  });
});
