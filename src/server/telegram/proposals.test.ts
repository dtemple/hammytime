import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('./bot', () => ({ telegramBot: vi.fn() }));

import { sweepExpiredProposals } from './proposals';
import { supabaseAdmin } from '@/lib/db';
import { telegramBot } from './bot';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

type PlanRow = {
  id: string;
  athlete_id: string;
  proposed_token: string | null;
  proposed_message_id: number | null;
};

function makeDb(opts: {
  plans: PlanRow[];
  chatIdByAthlete?: Record<string, string>;
  rpcResult?: string;
  onRpc?: (name: string, args: Record<string, unknown>) => void;
}) {
  return {
    from(table: string) {
      if (table === 'plans') {
        // select().not().lt() resolves the expired set.
        return {
          select: () => ({ not: () => ({ lt: () => Promise.resolve({ data: opts.plans, error: null }) }) }),
        };
      }
      if (table === 'athletes') {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: async () => ({
                data: opts.chatIdByAthlete?.[val]
                  ? { telegram_chat_id: opts.chatIdByAthlete[val] }
                  : null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      opts.onRpc?.(name, args);
      return { data: opts.rpcResult ?? 'discarded', error: null };
    },
  };
}

describe('sweepExpiredProposals', () => {
  const editMessageText = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (telegramBot as AnyMock).mockReturnValue({ api: { editMessageText } });
  });

  it('discards each expired proposal and resolves its stale button', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({
        plans: [
          { id: 'plan-1', athlete_id: 'a1', proposed_token: 'tok1', proposed_message_id: 1150 },
        ],
        chatIdByAthlete: { a1: '999' },
        rpcResult: 'discarded',
        onRpc: (name, args) => rpcCalls.push({ name, args }),
      }),
    );

    const n = await sweepExpiredProposals(new Date('2026-06-22T14:00:00Z'));

    expect(n).toBe(1);
    expect(rpcCalls).toEqual([
      { name: 'discard_proposed_version', args: { p_plan_id: 'plan-1', p_token: 'tok1' } },
    ]);
    expect(editMessageText).toHaveBeenCalledWith('999', 1150, expect.stringContaining('expired'));
  });

  it('skips a plan with no token and does not count a not_found discard', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({
        plans: [
          { id: 'plan-1', athlete_id: 'a1', proposed_token: null, proposed_message_id: 10 },
          { id: 'plan-2', athlete_id: 'a2', proposed_token: 'tok2', proposed_message_id: 20 },
        ],
        chatIdByAthlete: { a2: '888' },
        rpcResult: 'not_found',
      }),
    );

    const n = await sweepExpiredProposals(new Date('2026-06-22T14:00:00Z'));

    expect(n).toBe(0);
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it('returns 0 when nothing is expired', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ plans: [] }));
    expect(await sweepExpiredProposals()).toBe(0);
  });
});
