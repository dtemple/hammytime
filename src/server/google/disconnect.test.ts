import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('./token', () => ({ getGoogleAccessToken: vi.fn() }));
vi.mock('./client', () => ({ revokeToken: vi.fn() }));
vi.mock('./calendar-api', () => ({ deleteCalendar: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import { getGoogleAccessToken } from './token';
import { revokeToken } from './client';
import { deleteCalendar } from './calendar-api';
import { disconnectGoogleCalendar } from './disconnect';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-1';

function makeDb(deleteResult: { data: unknown[] | null; error: { message: string } | null }) {
  const selectMock = vi.fn().mockResolvedValue(deleteResult);
  const eq2 = vi.fn().mockReturnValue({ select: selectMock });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const deleteMock = vi.fn().mockReturnValue({ eq: eq1 });
  return { from: vi.fn().mockReturnValue({ delete: deleteMock }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  (revokeToken as AnyMock).mockResolvedValue(undefined);
  (deleteCalendar as AnyMock).mockResolvedValue(undefined);
});

describe('disconnectGoogleCalendar', () => {
  it('deletes the Daybreak calendar, revokes, and drops the row', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ data: [{ id: 'tok-1' }], error: null }));
    (getGoogleAccessToken as AnyMock).mockResolvedValue({ accessToken: 'at', calendarId: 'cal-1' });

    const result = await disconnectGoogleCalendar(ATHLETE_ID);

    expect(deleteCalendar).toHaveBeenCalledWith('at', 'cal-1');
    expect(revokeToken).toHaveBeenCalledWith('at');
    expect(result).toEqual({ hadConnection: true, calendarDeleted: true });
  });

  it('still drops the row when the token is already dead (refresh throws)', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ data: [{ id: 'tok-1' }], error: null }));
    (getGoogleAccessToken as AnyMock).mockRejectedValue(new Error('invalid_grant'));

    const result = await disconnectGoogleCalendar(ATHLETE_ID);

    expect(deleteCalendar).not.toHaveBeenCalled();
    expect(result).toEqual({ hadConnection: true, calendarDeleted: false });
  });

  it('still drops the row when the remote calendar delete fails', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ data: [{ id: 'tok-1' }], error: null }));
    (getGoogleAccessToken as AnyMock).mockResolvedValue({ accessToken: 'at', calendarId: 'cal-1' });
    (deleteCalendar as AnyMock).mockRejectedValue(new Error('Google 500'));

    const result = await disconnectGoogleCalendar(ATHLETE_ID);

    expect(result).toEqual({ hadConnection: true, calendarDeleted: false });
  });

  it('survives a failed revoke (calendar already deleted)', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ data: [{ id: 'tok-1' }], error: null }));
    (getGoogleAccessToken as AnyMock).mockResolvedValue({ accessToken: 'at', calendarId: 'cal-1' });
    (revokeToken as AnyMock).mockRejectedValue(new Error('Google 500'));

    const result = await disconnectGoogleCalendar(ATHLETE_ID);

    expect(result).toEqual({ hadConnection: true, calendarDeleted: true });
  });

  it('reports hadConnection false when there was no row', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ data: [], error: null }));
    (getGoogleAccessToken as AnyMock).mockResolvedValue(null);

    const result = await disconnectGoogleCalendar(ATHLETE_ID);

    expect(deleteCalendar).not.toHaveBeenCalled();
    expect(result).toEqual({ hadConnection: false, calendarDeleted: false });
  });

  it('throws when the row delete fails', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({ data: null, error: { message: 'permission denied' } }),
    );
    (getGoogleAccessToken as AnyMock).mockResolvedValue(null);

    await expect(disconnectGoogleCalendar(ATHLETE_ID)).rejects.toThrow(/permission denied/);
  });
});
