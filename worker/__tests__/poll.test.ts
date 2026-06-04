import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/admin/alerts', () => ({ sendDavidAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../jobs/daily-checkin', () => ({ runDailyCheckin: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../jobs/post-activity', () => ({ runPostActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../jobs/tg-message', () => ({ runTgMessage: vi.fn().mockResolvedValue(undefined) }));

import { claimJob, dispatch, completeJob, failJob, type Job } from '../poll';
import { supabaseAdmin } from '@/lib/db';
import { sendDavidAlert } from '@/server/admin/alerts';
import { runDailyCheckin } from '../jobs/daily-checkin';
import { runPostActivity } from '../jobs/post-activity';
import { runTgMessage } from '../jobs/tg-message';
import { MAX_ATTEMPTS } from '../config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

let rpcCalls: { name: string; args: unknown }[];
let rpcResult: { data: unknown; error: { message: string } | null };
let updateCalls: { payload: Record<string, unknown>; eq?: [string, unknown] }[];

function makeDb() {
  return {
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return rpcResult;
    },
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        const call: { payload: Record<string, unknown>; eq?: [string, unknown] } = { payload };
        updateCalls.push(call);
        return {
          eq: (col: string, val: unknown) => {
            call.eq = [col, val];
            return { error: null };
          },
        };
      },
    }),
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    kind: 'daily_checkin',
    payload: { athlete_id: 'ath-1' },
    attempts: 1,
    run_after: '2026-05-28T00:00:00Z',
    locked_at: null,
    last_error: null,
    completed_at: null,
    key_unique: null,
    ...overrides,
    // db-types may carry extra columns; cast covers them.
  } as unknown as Job;
}

beforeEach(() => {
  rpcCalls = [];
  updateCalls = [];
  rpcResult = { data: null, error: null };
  (supabaseAdmin as AnyMock).mockImplementation(() => makeDb());
  vi.clearAllMocks();
});

describe('claimJob', () => {
  it('calls the claim_next_job RPC and returns the claimed row', async () => {
    const row = makeJob();
    rpcResult = { data: row, error: null };
    const job = await claimJob();
    expect(rpcCalls[0]!.name).toBe('claim_next_job');
    expect(job).toEqual(row);
  });

  it('returns null when nothing is due (all-null composite)', async () => {
    rpcResult = { data: { id: null }, error: null };
    expect(await claimJob()).toBeNull();
  });

  it('throws when the RPC errors', async () => {
    rpcResult = { data: null, error: { message: 'boom' } };
    await expect(claimJob()).rejects.toThrow(/boom/);
  });
});

describe('dispatch', () => {
  it('routes daily_checkin to the daily handler', async () => {
    await dispatch(makeJob({ kind: 'daily_checkin', payload: { athlete_id: 'ath-9' } }));
    expect(runDailyCheckin).toHaveBeenCalledWith('ath-9');
  });

  it('routes a plain tg_message with its text', async () => {
    await dispatch(
      makeJob({ kind: 'tg_message', payload: { athlete_id: 'ath-9', text: 'how was my run?' } }),
    );
    expect(runTgMessage).toHaveBeenCalledWith('ath-9', 'how was my run?');
    expect(runPostActivity).not.toHaveBeenCalled();
  });

  it('routes a post_activity-flagged tg_message to the post-activity handler with the activity id', async () => {
    await dispatch(
      makeJob({
        kind: 'tg_message',
        payload: {
          athlete_id: 'ath-9',
          trigger: 'post_activity',
          strava_activity_id: 1360128428,
          text: 'fallback seed',
        },
      }),
    );
    expect(runPostActivity).toHaveBeenCalledWith('ath-9', 1360128428);
    expect(runTgMessage).not.toHaveBeenCalled();
  });

  it('routes a post_activity tg_message with no activity id (undefined)', async () => {
    await dispatch(
      makeJob({
        kind: 'tg_message',
        payload: { athlete_id: 'ath-9', trigger: 'post_activity' },
      }),
    );
    expect(runPostActivity).toHaveBeenCalledWith('ath-9', undefined);
  });

  it('throws when athlete_id is missing', async () => {
    await expect(dispatch(makeJob({ payload: {} }))).rejects.toThrow(/athlete_id/);
  });

  it('throws on an unknown kind', async () => {
    await expect(
      dispatch(makeJob({ kind: 'mystery' as Job['kind'], payload: { athlete_id: 'ath-1' } })),
    ).rejects.toThrow(/unknown job kind/);
  });
});

describe('completeJob', () => {
  it('marks completed_at and clears the lock + error', async () => {
    await completeJob('job-1');
    const call = updateCalls[0]!;
    expect(call.payload.completed_at).toBeTruthy();
    expect(call.payload.locked_at).toBeNull();
    expect(call.payload.last_error).toBeNull();
    expect(call.eq).toEqual(['id', 'job-1']);
  });
});

describe('failJob', () => {
  it('under the attempt cap: clears lock, records error, sets a future run_after', async () => {
    const before = Date.now();
    await failJob(makeJob({ attempts: 2 }), 'transient');
    const call = updateCalls[0]!;
    expect(call.payload.locked_at).toBeNull();
    expect(call.payload.last_error).toBe('transient');
    expect(new Date(call.payload.run_after as string).getTime()).toBeGreaterThan(before);
    expect(sendDavidAlert).not.toHaveBeenCalled();
  });

  it('at the attempt cap: terminal DEAD state and alerts David', async () => {
    await failJob(makeJob({ attempts: MAX_ATTEMPTS }), 'still broken');
    const call = updateCalls[0]!;
    expect(call.payload.last_error).toMatch(/^DEAD after/);
    expect(call.payload).not.toHaveProperty('run_after');
    expect(sendDavidAlert).toHaveBeenCalledOnce();
  });
});
