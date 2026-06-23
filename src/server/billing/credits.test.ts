// Contract tests for the credit wrappers over the billing RPCs / tables. The
// RPCs' DB-level behavior (idempotency, overshoot, comped short-circuit,
// ledger/balance-in-sync) is verified live against the DB (see verification
// output); these tests pin each wrapper's argument shape + result mapping.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
const maybeSingle = vi.fn();
// from('athlete_credits').select(...).eq(...).maybeSingle()
const from = vi.fn(() => ({
  select: () => ({ eq: () => ({ maybeSingle }) }),
}));
vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => ({ rpc, from }),
}));

import {
  grantSignupCredit,
  debitRunCredit,
  getCreditState,
  recordStripeTopup,
  recordStripeRefund,
  applyStripeCredit,
  SIGNUP_GRANT_CENTS,
} from './credits';

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

describe('debitRunCredit', () => {
  beforeEach(() => rpc.mockReset());

  it('calls debit_run_credit with athlete id, run id, and cents', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await debitRunCredit('athlete-1', 'run-9', 80);
    expect(rpc).toHaveBeenCalledWith('debit_run_credit', {
      p_athlete_id: 'athlete-1',
      p_run_id: 'run-9',
      p_amount_cents: 80,
    });
  });

  it('returns true when the run was debited', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await debitRunCredit('athlete-1', 'run-9', 80)).toBe(true);
  });

  it('returns false on a skip (comped or already debited)', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await debitRunCredit('athlete-1', 'run-9', 80)).toBe(false);
  });

  it('throws when the RPC errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(debitRunCredit('athlete-1', 'run-9', 80)).rejects.toEqual({ message: 'boom' });
  });
});

describe('getCreditState', () => {
  beforeEach(() => maybeSingle.mockReset());

  it('maps the row to balanceCents + comped', async () => {
    maybeSingle.mockResolvedValue({ data: { balance_cents: 420, comped: false }, error: null });
    expect(await getCreditState('athlete-1')).toEqual({ balanceCents: 420, comped: false });
  });

  it('returns null when there is no billing row', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getCreditState('athlete-1')).toBeNull();
  });

  it('throws when the read errors', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(getCreditState('athlete-1')).rejects.toEqual({ message: 'boom' });
  });
});

describe('recordStripeTopup', () => {
  beforeEach(() => rpc.mockReset().mockResolvedValue({ data: true, error: null }));

  it('calls apply_stripe_credit with a POSITIVE amount + kind=topup', async () => {
    await recordStripeTopup('athlete-1', 'pi_1', 2500);
    expect(rpc).toHaveBeenCalledWith('apply_stripe_credit', {
      p_athlete_id: 'athlete-1',
      p_payment_intent: 'pi_1',
      p_amount_cents: 2500,
      p_kind: 'topup',
    });
  });

  it('owns the sign — a negative gross is coerced positive', async () => {
    await recordStripeTopup('athlete-1', 'pi_1', -2500);
    expect(rpc).toHaveBeenCalledWith(
      'apply_stripe_credit',
      expect.objectContaining({ p_amount_cents: 2500, p_kind: 'topup' }),
    );
  });
});

describe('recordStripeRefund', () => {
  beforeEach(() => rpc.mockReset().mockResolvedValue({ data: true, error: null }));

  it('calls apply_stripe_credit with a NEGATIVE amount + kind=refund', async () => {
    await recordStripeRefund('athlete-1', 'pi_1', 2500);
    expect(rpc).toHaveBeenCalledWith('apply_stripe_credit', {
      p_athlete_id: 'athlete-1',
      p_payment_intent: 'pi_1',
      p_amount_cents: -2500,
      p_kind: 'refund',
    });
  });

  it('always stores the refund signed-negative regardless of caller sign', async () => {
    await recordStripeRefund('athlete-1', 'pi_1', -2500);
    expect(rpc).toHaveBeenCalledWith(
      'apply_stripe_credit',
      expect.objectContaining({ p_amount_cents: -2500, p_kind: 'refund' }),
    );
  });
});

describe('applyStripeCredit result mapping', () => {
  beforeEach(() => rpc.mockReset());

  it('returns true when the RPC wrote the row', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await applyStripeCredit('athlete-1', 'pi_1', 2500, 'topup')).toBe(true);
  });

  it('returns false on the replay no-op (RPC returns false)', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await applyStripeCredit('athlete-1', 'pi_1', 2500, 'topup')).toBe(false);
  });

  it('throws when the RPC errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(applyStripeCredit('athlete-1', 'pi_1', 2500, 'topup')).rejects.toEqual({
      message: 'boom',
    });
  });
});
