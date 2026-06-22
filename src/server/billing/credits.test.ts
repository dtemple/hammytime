// Contract tests for grantSignupCredit — the TS wrapper over the
// grant_signup_credit RPC. The RPC's idempotency + ledger/balance-in-sync
// behavior is verified live against the DB (see verification output); these tests
// pin the wrapper's argument shape and result mapping.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => ({ rpc }),
}));

import { grantSignupCredit, SIGNUP_GRANT_CENTS } from './credits';

describe('grantSignupCredit', () => {
  beforeEach(() => rpc.mockReset());

  it('calls grant_signup_credit with the athlete id and $5 in cents', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await grantSignupCredit('athlete-1');
    expect(rpc).toHaveBeenCalledWith('grant_signup_credit', {
      p_athlete_id: 'athlete-1',
      p_amount_cents: SIGNUP_GRANT_CENTS,
    });
    expect(SIGNUP_GRANT_CENTS).toBe(500);
  });

  it('returns true when the grant was written', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await grantSignupCredit('athlete-1')).toBe(true);
  });

  it('returns false when the athlete already had a grant (idempotent no-op)', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await grantSignupCredit('athlete-1')).toBe(false);
  });

  it('throws when the RPC errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(grantSignupCredit('athlete-1')).rejects.toEqual({ message: 'boom' });
  });
});
