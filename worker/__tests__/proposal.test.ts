import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));

import { diffSummary, loadPendingProposal, discardPendingProposal } from '../proposal';
import { supabaseAdmin } from '@/lib/db';
import type { Plan } from '@/lib/plan-schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE = '11111111-2222-3333-4444-555555555555';

// Minimal day/plan shapes — diffSummary reads only date, type, and
// planned_distance_miles, so cast through unknown rather than build full schema.
function day(date: string, type: string, miles?: number) {
  return { day: 'Day', date, type, description: 'x', planned_distance_miles: miles };
}
function plan(days: ReturnType<typeof day>[]): Plan {
  return { weeks: [{ week_number: 1, days }] } as unknown as Plan;
}

describe('diffSummary — human-readable plan diff', () => {
  it('renders a changed day as before → after', () => {
    const active = plan([day('2026-06-25', 'tempo', 4)]);
    const proposed = plan([day('2026-06-25', 'rest')]);
    expect(diffSummary(active, proposed)).toBe('Thu Jun 25: tempo 4mi → rest');
  });

  it('omits unchanged days', () => {
    const active = plan([day('2026-06-24', 'easy', 5), day('2026-06-25', 'tempo', 4)]);
    const proposed = plan([day('2026-06-24', 'easy', 5), day('2026-06-25', 'rest')]);
    const out = diffSummary(active, proposed);
    expect(out).toBe('Thu Jun 25: tempo 4mi → rest');
    expect(out).not.toContain('Jun 24');
  });

  it('flags added and removed dated days', () => {
    const active = plan([day('2026-06-25', 'tempo', 4)]);
    const proposed = plan([day('2026-06-26', 'easy', 6)]);
    const out = diffSummary(active, proposed);
    expect(out).toContain('Thu Jun 25: removed (was tempo 4mi)');
    expect(out).toContain('Fri Jun 26: added easy 6mi');
  });
});

// Chainable mock: from('plans') resolves a single plan row; from('plan_versions')
// resolves a single version row; rpc returns a configured result.
function makeDb(opts: {
  planRow?: Record<string, unknown> | null;
  versionRow?: Record<string, unknown> | null;
  rpcResult?: string;
  rpcError?: { message: string } | null;
  onRpc?: (name: string, args: Record<string, unknown>) => void;
}) {
  return {
    from(table: string) {
      const data =
        table === 'plans' ? (opts.planRow ?? null) : (opts.versionRow ?? null);
      const leaf = { maybeSingle: async () => ({ data }) };
      // plans: select().eq().order().limit().maybeSingle()
      // plan_versions: select().eq().maybeSingle()
      const eqReturn = {
        order: () => ({ limit: () => leaf }),
        maybeSingle: leaf.maybeSingle,
      };
      return { select: () => ({ eq: () => eqReturn }) };
    },
    rpc(name: string, args: Record<string, unknown>) {
      opts.onRpc?.(name, args);
      return { data: opts.rpcResult ?? null, error: opts.rpcError ?? null };
    },
  };
}

describe('loadPendingProposal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no proposal is outstanding', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ planRow: { proposed_version_id: null } }));
    expect(await loadPendingProposal(ATHLETE, null)).toBeNull();
  });

  it('returns null for an expired proposal', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({
        planRow: { proposed_version_id: 'v9', proposed_expires_at: '2026-06-01T00:00:00Z' },
      }),
    );
    const out = await loadPendingProposal(ATHLETE, null, new Date('2026-06-22T00:00:00Z'));
    expect(out).toBeNull();
  });

  it('summarizes a live proposed version against the active plan', async () => {
    const active = plan([day('2026-06-25', 'tempo', 4)]);
    const proposed = plan([day('2026-06-25', 'rest')]);
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({
        planRow: { proposed_version_id: 'v9', proposed_expires_at: '2026-06-25T06:59:59Z' },
        versionRow: { status: 'proposed', plan_json: proposed },
      }),
    );
    const out = await loadPendingProposal(ATHLETE, active, new Date('2026-06-22T00:00:00Z'));
    expect(out).toEqual({
      summary: 'Thu Jun 25: tempo 4mi → rest',
      expiresAt: '2026-06-25T06:59:59Z',
    });
  });

  it('returns null when the referenced version is no longer proposed', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({
        planRow: { proposed_version_id: 'v9', proposed_expires_at: '2026-06-25T06:59:59Z' },
        versionRow: { status: 'discarded', plan_json: plan([day('2026-06-25', 'rest')]) },
      }),
    );
    expect(await loadPendingProposal(ATHLETE, null, new Date('2026-06-22T00:00:00Z'))).toBeNull();
  });
});

describe('discardPendingProposal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('discards the outstanding proposal and returns its stale message id', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({
        planRow: {
          id: 'plan-1',
          proposed_token: 'tok',
          proposed_message_id: 1150,
          proposed_version_id: 'v9',
        },
        rpcResult: 'discarded',
        onRpc: (name, args) => rpcCalls.push({ name, args }),
      }),
    );
    const out = await discardPendingProposal(ATHLETE);
    expect(out).toEqual({ discarded: true, staleMessageId: 1150 });
    expect(rpcCalls).toEqual([
      { name: 'discard_proposed_version', args: { p_plan_id: 'plan-1', p_token: 'tok' } },
    ]);
  });

  it('no-ops when nothing is pending', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({ planRow: { id: 'plan-1', proposed_version_id: null, proposed_token: null } }),
    );
    expect(await discardPendingProposal(ATHLETE)).toEqual({ discarded: false });
  });
});
