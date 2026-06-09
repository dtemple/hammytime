import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./token', () => ({ getGoogleAccessToken: vi.fn() }));
vi.mock('@/server/plans/active-plan', () => ({ loadCalendarRenderInput: vi.fn() }));
vi.mock('@/lib/calendar-events', () => ({ planToCalendarEvents: vi.fn() }));
vi.mock('./calendar-api', () => ({
  listAllEvents: vi.fn(),
  importEvent: vi.fn(),
  findEventByUid: vi.fn(),
  patchEvent: vi.fn(),
  deleteEvent: vi.fn(),
  sleep: { fn: vi.fn().mockResolvedValue(undefined) },
}));

import { getGoogleAccessToken } from './token';
import { loadCalendarRenderInput } from '@/server/plans/active-plan';
import { planToCalendarEvents, type CalendarEvent } from '@/lib/calendar-events';
import {
  deleteEvent,
  findEventByUid,
  importEvent,
  listAllEvents,
  patchEvent,
  type GoogleEvent,
} from './calendar-api';
import { reconcileCalendar } from './sync';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'athlete-1';

function localEvent(n: number, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    uid: `plan-w1-d${n}@hammytime`,
    date: `2026-07-0${n + 1}`,
    summary: `🏃 Run ${n}`,
    description: `desc ${n}`,
    ...overrides,
  };
}

// The Google-side twin of localEvent(n) — what a clean prior sync left behind.
function remoteEvent(n: number, overrides: Partial<GoogleEvent> = {}): GoogleEvent {
  return {
    id: `gid-${n}`,
    iCalUID: `plan-w1-d${n}@hammytime`,
    summary: `🏃 Run ${n}`,
    description: `desc ${n}`,
    start: { date: `2026-07-0${n + 1}` },
    end: { date: `2026-07-0${n + 2}` },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getGoogleAccessToken as AnyMock).mockResolvedValue({ accessToken: 'at', calendarId: 'cal-1' });
  (loadCalendarRenderInput as AnyMock).mockResolvedValue({
    athleteName: 'Test',
    timezone: 'America/Los_Angeles',
    plan: {},
    planId: 'plan',
    planStartDate: '2026-07-01',
  });
  (planToCalendarEvents as AnyMock).mockReturnValue([]);
  (listAllEvents as AnyMock).mockResolvedValue([]);
  (importEvent as AnyMock).mockResolvedValue({ conflict: false });
});

describe('reconcileCalendar', () => {
  it('no-ops when the athlete has no Google connection', async () => {
    (getGoogleAccessToken as AnyMock).mockResolvedValue(null);
    const result = await reconcileCalendar(ATHLETE_ID);
    expect(result).toEqual({ imported: 0, patched: 0, deleted: 0, skipped: 0 });
    expect(listAllEvents).not.toHaveBeenCalled();
  });

  it('no-ops when the connection has no calendar id', async () => {
    (getGoogleAccessToken as AnyMock).mockResolvedValue({ accessToken: 'at', calendarId: null });
    const result = await reconcileCalendar(ATHLETE_ID);
    expect(result.imported).toBe(0);
    expect(listAllEvents).not.toHaveBeenCalled();
  });

  it('imports every event into an empty calendar with exclusive end dates', async () => {
    (planToCalendarEvents as AnyMock).mockReturnValue([0, 1, 2].map((n) => localEvent(n)));

    const result = await reconcileCalendar(ATHLETE_ID);

    expect(result).toEqual({ imported: 3, patched: 0, deleted: 0, skipped: 0 });
    expect(importEvent).toHaveBeenCalledTimes(3);
    const first = (importEvent as AnyMock).mock.calls[0][2];
    expect(first.iCalUID).toBe('plan-w1-d0@hammytime');
    expect(first.start).toEqual({ date: '2026-07-01' });
    expect(first.end).toEqual({ date: '2026-07-02' }); // Google all-day end is exclusive
  });

  it('is idempotent — an identical remote produces zero writes', async () => {
    (planToCalendarEvents as AnyMock).mockReturnValue([0, 1, 2].map((n) => localEvent(n)));
    (listAllEvents as AnyMock).mockResolvedValue([0, 1, 2].map((n) => remoteEvent(n)));

    const result = await reconcileCalendar(ATHLETE_ID);

    expect(result).toEqual({ imported: 0, patched: 0, deleted: 0, skipped: 3 });
    expect(importEvent).not.toHaveBeenCalled();
    expect(patchEvent).not.toHaveBeenCalled();
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it('patches exactly the event whose content changed', async () => {
    (planToCalendarEvents as AnyMock).mockReturnValue([
      localEvent(0),
      localEvent(1, { summary: '🏃 Run 1 — now 8mi' }),
    ]);
    (listAllEvents as AnyMock).mockResolvedValue([remoteEvent(0), remoteEvent(1)]);

    const result = await reconcileCalendar(ATHLETE_ID);

    expect(result).toEqual({ imported: 0, patched: 1, deleted: 0, skipped: 1 });
    expect(patchEvent).toHaveBeenCalledTimes(1);
    expect((patchEvent as AnyMock).mock.calls[0][2]).toBe('gid-1');
    expect((patchEvent as AnyMock).mock.calls[0][3].summary).toBe('🏃 Run 1 — now 8mi');
  });

  it('treats a moved date as a change', async () => {
    (planToCalendarEvents as AnyMock).mockReturnValue([localEvent(0, { date: '2026-07-05' })]);
    (listAllEvents as AnyMock).mockResolvedValue([remoteEvent(0)]);

    const result = await reconcileCalendar(ATHLETE_ID);
    expect(result.patched).toBe(1);
    expect((patchEvent as AnyMock).mock.calls[0][3].start).toEqual({ date: '2026-07-05' });
    expect((patchEvent as AnyMock).mock.calls[0][3].end).toEqual({ date: '2026-07-06' });
  });

  it('deletes our stale events but never touches foreign ones', async () => {
    (planToCalendarEvents as AnyMock).mockReturnValue([localEvent(0)]);
    (listAllEvents as AnyMock).mockResolvedValue([
      remoteEvent(0),
      remoteEvent(7), // ours, no longer in the plan
      { id: 'gid-x', iCalUID: 'something-the-athlete-added@google.com', summary: 'Dentist' },
    ]);

    const result = await reconcileCalendar(ATHLETE_ID);

    expect(result.deleted).toBe(1);
    expect(deleteEvent).toHaveBeenCalledTimes(1);
    expect((deleteEvent as AnyMock).mock.calls[0][2]).toBe('gid-7');
  });

  it('resurrects a cancelled tombstone on import conflict', async () => {
    (planToCalendarEvents as AnyMock).mockReturnValue([localEvent(0)]);
    (importEvent as AnyMock).mockResolvedValue({ conflict: true });
    (findEventByUid as AnyMock).mockResolvedValue({
      id: 'gid-tomb',
      iCalUID: 'plan-w1-d0@hammytime',
      status: 'cancelled',
    });

    const result = await reconcileCalendar(ATHLETE_ID);

    expect(result).toEqual({ imported: 0, patched: 1, deleted: 0, skipped: 0 });
    const patch = (patchEvent as AnyMock).mock.calls[0][3];
    expect(patch.status).toBe('confirmed');
    expect(patch.summary).toBe('🏃 Run 0');
  });

  it('lets a mid-run failure propagate so the job retries (and converges on re-run)', async () => {
    (planToCalendarEvents as AnyMock).mockReturnValue([localEvent(0), localEvent(1)]);
    (importEvent as AnyMock)
      .mockResolvedValueOnce({ conflict: false })
      .mockRejectedValueOnce(new Error('Google Calendar events.import failed (500)'));

    await expect(reconcileCalendar(ATHLETE_ID)).rejects.toThrow(/events.import/);
  });

  it("treats remote '' and absent location as equal (no spurious patch)", async () => {
    (planToCalendarEvents as AnyMock).mockReturnValue([localEvent(0)]);
    (listAllEvents as AnyMock).mockResolvedValue([remoteEvent(0, { location: '' })]);

    const result = await reconcileCalendar(ATHLETE_ID);
    expect(result.patched).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
