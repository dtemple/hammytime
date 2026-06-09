import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/crypto', () => ({ decryptToken: vi.fn(), encryptToken: vi.fn() }));
vi.mock('./client', () => ({
  refreshAccessToken: vi.fn(),
  GoogleAuthRevokedError: class GoogleAuthRevokedError extends Error {},
}));

import { supabaseAdmin } from '@/lib/db';
import { decryptToken, encryptToken } from '@/lib/crypto';
import { refreshAccessToken } from './client';
import { getGoogleAccessToken } from './token';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-1';

function makeDb(row: object | null) {
  const updateEq2 = vi.fn().mockResolvedValue({ error: null });
  const updateEq1 = vi.fn().mockReturnValue({ eq: updateEq2 });
  const updateMock = vi.fn().mockReturnValue({ eq: updateEq1 });
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
          }),
        }),
      }),
      update: updateMock,
    }),
    _updateMock: updateMock,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (decryptToken as AnyMock).mockImplementation(async (enc: string) => `dec(${enc})`);
  (encryptToken as AnyMock).mockImplementation(async (plain: string) => `enc(${plain})`);
});

describe('getGoogleAccessToken', () => {
  it('returns null when the athlete has no google_calendar row', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb(null));
    expect(await getGoogleAccessToken(ATHLETE_ID)).toBeNull();
  });

  it('returns the decrypted token and calendar id while still valid', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({
        access_token_enc: 'at-enc',
        refresh_token_enc: 'rt-enc',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        provider_calendar_id: 'cal-1',
      }),
    );
    const conn = await getGoogleAccessToken(ATHLETE_ID);
    expect(conn).toEqual({ accessToken: 'dec(at-enc)', calendarId: 'cal-1' });
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes an expiring token and persists only the new access token', async () => {
    const db = makeDb({
      access_token_enc: 'at-enc',
      refresh_token_enc: 'rt-enc',
      expires_at: new Date(Date.now() + 60 * 1000).toISOString(), // inside the 5-min window
      provider_calendar_id: 'cal-1',
    });
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    (refreshAccessToken as AnyMock).mockResolvedValue({
      access_token: 'new-at',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    const conn = await getGoogleAccessToken(ATHLETE_ID);

    expect(refreshAccessToken).toHaveBeenCalledWith('dec(rt-enc)');
    expect(conn).toEqual({ accessToken: 'new-at', calendarId: 'cal-1' });
    // The stored refresh token must survive a refresh untouched — Google
    // doesn't rotate it, and overwriting it would brick the connection.
    const updatePayload = db._updateMock.mock.calls[0]![0];
    expect(updatePayload.access_token_enc).toBe('enc(new-at)');
    expect(updatePayload).not.toHaveProperty('refresh_token_enc');
  });

  it('propagates refresh failures (including revocation)', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({
        access_token_enc: 'at-enc',
        refresh_token_enc: 'rt-enc',
        expires_at: new Date(Date.now() - 1000).toISOString(),
        provider_calendar_id: 'cal-1',
      }),
    );
    (refreshAccessToken as AnyMock).mockRejectedValue(new Error('revoked'));
    await expect(getGoogleAccessToken(ATHLETE_ID)).rejects.toThrow('revoked');
  });
});
