import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/jobs/enqueue', () => ({ enqueueJob: vi.fn().mockResolvedValue(undefined) }));

import { supabaseAdmin } from '@/lib/db';
import { enqueueJob } from '@/server/jobs/enqueue';
import { handleActivityCreate } from './activity-trigger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const PROVIDER_ID = '134815';
const ATHLETE_ID = 'athlete-uuid-1';
const CHAT_ID = '987654321';
const OBJECT_ID = 1360128428;

// Onboarded athletes have step >= onboardingSteps.length; 99 clears any length.
function makeAthlete(overrides: Record<string, unknown> = {}) {
  return {
    id: ATHLETE_ID,
    telegram_chat_id: CHAT_ID,
    onboarding_state: { step: 99 },
    ...overrides,
  };
}

/**
 * db mock dispatching by table:
 *  - oauth_tokens: select().eq().eq().maybeSingle()
 *  - athletes:     select().eq().maybeSingle()
 *  - job_queue:    select().in().like().gte().limit().maybeSingle()
 */
function makeDb(
  opts: {
    tokenRow?: object | null;
    athleteRow?: object | null;
    recentRow?: object | null;
  } = {},
) {
  const {
    tokenRow = { athlete_id: ATHLETE_ID },
    athleteRow = makeAthlete(),
    recentRow = null,
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
      if (table === 'job_queue') {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({
              like: vi.fn().mockReturnValue({
                gte: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: recentRow, error: null }),
                  }),
                }),
              }),
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
});

describe('handleActivityCreate', () => {
  it('enqueues a tg_message keyed to the activity for an onboarded athlete', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb());

    await handleActivityCreate(PROVIDER_ID, OBJECT_ID);

    expect(enqueueJob).toHaveBeenCalledOnce();
    const [kind, key, payload] = (enqueueJob as AnyMock).mock.calls[0];
    expect(kind).toBe('tg_message');
    expect(key).toBe(`tg_strava:${ATHLETE_ID}:${OBJECT_ID}`);
    expect(payload.athlete_id).toBe(ATHLETE_ID);
    expect(typeof payload.text).toBe('string');
    expect(payload.text.length).toBeGreaterThan(0);
  });

  it('does nothing when no token row matches the Strava athlete', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ tokenRow: null }));
    await handleActivityCreate(PROVIDER_ID, OBJECT_ID);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('does nothing when the athlete row is missing', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ athleteRow: null }));
    await handleActivityCreate(PROVIDER_ID, OBJECT_ID);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('skips an athlete with no telegram_chat_id', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({ athleteRow: makeAthlete({ telegram_chat_id: null }) }),
    );
    await handleActivityCreate(PROVIDER_ID, OBJECT_ID);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('skips a test athlete (negative chat id)', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({ athleteRow: makeAthlete({ telegram_chat_id: '-1001234' }) }),
    );
    await handleActivityCreate(PROVIDER_ID, OBJECT_ID);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('skips an athlete who has not finished onboarding', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({ athleteRow: makeAthlete({ onboarding_state: { step: 0 } }) }),
    );
    await handleActivityCreate(PROVIDER_ID, OBJECT_ID);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('stands down when a coaching run was enqueued within the cooldown', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ recentRow: { id: 'job-1' } }));
    await handleActivityCreate(PROVIDER_ID, OBJECT_ID);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
