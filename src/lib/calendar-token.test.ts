import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  supabaseAdmin: vi.fn(),
}));

import { getOrCreateCalendarToken, getOrCreatePrehabToken } from './calendar-token';
import { supabaseAdmin } from '@/lib/db';

type SelectChain = {
  data: { token: string; expires_at: string } | null;
  error: null | { message: string };
};

function makeMock(opts: { existing: SelectChain; insertError?: { message: string } | null }) {
  const maybeSingle = vi.fn().mockResolvedValue(opts.existing);
  const limit = vi.fn().mockReturnValue({ maybeSingle });
  const order = vi.fn().mockReturnValue({ limit });
  const gt = vi.fn().mockReturnValue({ order });
  const eqPurpose = vi.fn().mockReturnValue({ gt });
  const eqAthlete = vi.fn().mockReturnValue({ eq: eqPurpose });
  const select = vi.fn().mockReturnValue({ eq: eqAthlete });

  const insertSpy = vi.fn().mockResolvedValue({ error: opts.insertError ?? null });

  const from = vi.fn().mockImplementation((_table: string) => ({
    select,
    insert: insertSpy,
  }));

  return { client: { from }, insertSpy };
}

describe('getOrCreateCalendarToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = 'https://hammytime.test';
  });

  it('returns existing token without inserting when one is present and unexpired', async () => {
    const mock = makeMock({
      existing: { data: { token: 'abc123', expires_at: '2099-01-01' }, error: null },
    });
    vi.mocked(supabaseAdmin).mockReturnValue(
      mock.client as unknown as ReturnType<typeof supabaseAdmin>,
    );

    const result = await getOrCreateCalendarToken('athlete-1');

    expect(result.token).toBe('abc123');
    expect(result.url).toBe('https://hammytime.test/api/calendar/abc123.ics');
    expect(mock.insertSpy).not.toHaveBeenCalled();
  });

  it('mints a new token when no existing row is found', async () => {
    const mock = makeMock({ existing: { data: null, error: null } });
    vi.mocked(supabaseAdmin).mockReturnValue(
      mock.client as unknown as ReturnType<typeof supabaseAdmin>,
    );

    const result = await getOrCreateCalendarToken('athlete-2');

    expect(mock.insertSpy).toHaveBeenCalledTimes(1);
    const inserted = mock.insertSpy.mock.calls[0]![0];
    expect(inserted.athlete_id).toBe('athlete-2');
    expect(inserted.purpose).toBe('calendar');
    expect(typeof inserted.token).toBe('string');
    expect(inserted.token.length).toBeGreaterThan(20);
    expect(new Date(inserted.expires_at).getTime()).toBeGreaterThan(
      Date.now() + 4 * 365 * 24 * 60 * 60 * 1000,
    );
    expect(result.token).toBe(inserted.token);
    expect(result.url).toBe(`https://hammytime.test/api/calendar/${inserted.token}.ics`);
  });

  it('throws when the insert fails', async () => {
    const mock = makeMock({
      existing: { data: null, error: null },
      insertError: { message: 'unique violation' },
    });
    vi.mocked(supabaseAdmin).mockReturnValue(
      mock.client as unknown as ReturnType<typeof supabaseAdmin>,
    );

    await expect(getOrCreateCalendarToken('athlete-3')).rejects.toThrow(/unique violation/);
  });
});

describe('getOrCreatePrehabToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = 'https://hammytime.test';
  });

  it('returns existing token with a /prehab URL without inserting', async () => {
    const mock = makeMock({
      existing: { data: { token: 'pre456', expires_at: '2099-01-01' }, error: null },
    });
    vi.mocked(supabaseAdmin).mockReturnValue(
      mock.client as unknown as ReturnType<typeof supabaseAdmin>,
    );

    const result = await getOrCreatePrehabToken('athlete-1');

    expect(result.token).toBe('pre456');
    expect(result.url).toBe('https://hammytime.test/prehab/pre456');
    expect(mock.insertSpy).not.toHaveBeenCalled();
  });

  it("mints with purpose 'prehab' when no row exists", async () => {
    const mock = makeMock({ existing: { data: null, error: null } });
    vi.mocked(supabaseAdmin).mockReturnValue(
      mock.client as unknown as ReturnType<typeof supabaseAdmin>,
    );

    const result = await getOrCreatePrehabToken('athlete-2');

    expect(mock.insertSpy).toHaveBeenCalledTimes(1);
    const inserted = mock.insertSpy.mock.calls[0]![0];
    expect(inserted.athlete_id).toBe('athlete-2');
    expect(inserted.purpose).toBe('prehab');
    expect(inserted.token.length).toBeGreaterThan(20);
    expect(result.url).toBe(`https://hammytime.test/prehab/${inserted.token}`);
  });

  it('throws when the insert fails', async () => {
    const mock = makeMock({
      existing: { data: null, error: null },
      insertError: { message: 'check violation' },
    });
    vi.mocked(supabaseAdmin).mockReturnValue(
      mock.client as unknown as ReturnType<typeof supabaseAdmin>,
    );

    await expect(getOrCreatePrehabToken('athlete-3')).rejects.toThrow(
      /Failed to mint prehab token: check violation/,
    );
  });
});
