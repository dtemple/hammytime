import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('./activities', () => ({ getAccessToken: vi.fn() }));
vi.mock('./client', () => ({ deauthorize: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import { getAccessToken } from './activities';
import { deauthorize } from './client';
import { disconnectStrava } from './disconnect';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-1';

// Mocks db.from('oauth_tokens').delete().eq().eq().select('id') → { data, error }
function makeDb(deleteResult: { data: unknown[] | null; error: { message: string } | null }) {
  const selectMock = vi.fn().mockResolvedValue(deleteResult);
  const eq2 = vi.fn().mockReturnValue({ select: selectMock });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const deleteMock = vi.fn().mockReturnValue({ eq: eq1 });
  return {
    from: vi.fn().mockReturnValue({ delete: deleteMock }),
    _deleteMock: deleteMock,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('disconnectStrava', () => {
  it('revokes on Strava then deletes when revokeOnStrava is true', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ data: [{ id: 'tok-1' }], error: null }));
    (getAccessToken as AnyMock).mockResolvedValue('fresh-access-token');
    (deauthorize as AnyMock).mockResolvedValue(undefined);

    const result = await disconnectStrava(ATHLETE_ID, { revokeOnStrava: true });

    expect(deauthorize).toHaveBeenCalledWith('fresh-access-token');
    expect(result).toEqual({ hadConnection: true, revoked: true });
  });

  it('skips Strava revocation when revokeOnStrava is false', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ data: [{ id: 'tok-1' }], error: null }));

    const result = await disconnectStrava(ATHLETE_ID, { revokeOnStrava: false });

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(deauthorize).not.toHaveBeenCalled();
    expect(result).toEqual({ hadConnection: true, revoked: false });
  });

  it('still deletes the token when Strava revocation fails', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ data: [{ id: 'tok-1' }], error: null }));
    (getAccessToken as AnyMock).mockResolvedValue('fresh-access-token');
    (deauthorize as AnyMock).mockRejectedValue(new Error('Strava 500'));

    const result = await disconnectStrava(ATHLETE_ID, { revokeOnStrava: true });

    expect(result).toEqual({ hadConnection: true, revoked: false });
  });

  it('reports hadConnection false when no row was deleted', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ data: [], error: null }));

    const result = await disconnectStrava(ATHLETE_ID, { revokeOnStrava: false });

    expect(result).toEqual({ hadConnection: false, revoked: false });
  });

  it('throws when the delete fails', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({ data: null, error: { message: 'permission denied' } }),
    );

    await expect(disconnectStrava(ATHLETE_ID, { revokeOnStrava: false })).rejects.toThrow(
      /permission denied/,
    );
  });
});
