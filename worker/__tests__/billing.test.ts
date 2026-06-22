// Unit tests for the worker's metering orchestration (worker/billing.ts).
// billedCents (pure) is real; the atomic debit / balance read (credits.ts) and
// the Telegram surface (send.ts) are mocked. The RPCs' DB behavior is verified
// live against the DB — see the verification output.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { debitRunCredit, getCreditState, sendDavidAlert, sendReply } = vi.hoisted(() => ({
  debitRunCredit: vi.fn(),
  getCreditState: vi.fn(),
  sendDavidAlert: vi.fn(),
  sendReply: vi.fn(),
}));
vi.mock('@/server/billing/credits', () => ({ debitRunCredit, getCreditState }));
vi.mock('../send', () => ({ sendDavidAlert, sendReply }));

import { chargeRun, enforceCreditGate } from '../billing';

const ATHLETE = '11111111-2222-3333-4444-555555555555';
const job = (kind: string, athleteId: string = ATHLETE) => ({
  kind,
  payload: { athlete_id: athleteId },
});

beforeEach(() => {
  debitRunCredit.mockReset().mockResolvedValue(true);
  getCreditState.mockReset();
  sendDavidAlert.mockReset().mockResolvedValue(undefined);
  sendReply.mockReset().mockResolvedValue(undefined);
  delete process.env.BILLING_GATE_ENABLED;
});

describe('chargeRun — post-run draw-down', () => {
  it('debits cost × 1.5 in whole cents for a priced run', async () => {
    await chargeRun(ATHLETE, 'run-1', 0.53); // → 80¢
    expect(debitRunCredit).toHaveBeenCalledWith(ATHLETE, 'run-1', 80);
  });

  it('skips a free/unpriced run (no 0¢ noise row)', async () => {
    await chargeRun(ATHLETE, 'run-1', 0);
    await chargeRun(ATHLETE, 'run-2', null);
    await chargeRun(ATHLETE, 'run-3', undefined);
    expect(debitRunCredit).not.toHaveBeenCalled();
  });

  it('swallows a debit failure — never blocks delivery', async () => {
    debitRunCredit.mockRejectedValue(new Error('db down'));
    await expect(chargeRun(ATHLETE, 'run-1', 0.5)).resolves.toBeUndefined();
  });

  it('tolerates a comped/already-debited no-op (RPC returns false)', async () => {
    debitRunCredit.mockResolvedValue(false);
    await expect(chargeRun(ATHLETE, 'run-1', 0.5)).resolves.toBeUndefined();
  });
});

describe('enforceCreditGate — pre-run $0 gate', () => {
  it('is OFF by default — a $0 non-comped athlete still runs, untouched', async () => {
    getCreditState.mockResolvedValue({ balanceCents: 0, comped: false });
    expect(await enforceCreditGate(job('daily_checkin'))).toBe('allowed');
    expect(getCreditState).not.toHaveBeenCalled(); // short-circuits before any read
    expect(sendReply).not.toHaveBeenCalled();
    expect(sendDavidAlert).not.toHaveBeenCalled();
  });

  describe('with BILLING_GATE_ENABLED on', () => {
    beforeEach(() => {
      process.env.BILLING_GATE_ENABLED = 'true';
    });

    it('allows a non-gated kind without reading the balance', async () => {
      expect(await enforceCreditGate(job('calendar_sync'))).toBe('allowed');
      expect(getCreditState).not.toHaveBeenCalled();
    });

    it('allows a comped athlete regardless of balance', async () => {
      getCreditState.mockResolvedValue({ balanceCents: -500, comped: true });
      expect(await enforceCreditGate(job('daily_checkin'))).toBe('allowed');
      expect(sendReply).not.toHaveBeenCalled();
    });

    it('allows a non-comped athlete with a positive balance', async () => {
      getCreditState.mockResolvedValue({ balanceCents: 1, comped: false });
      expect(await enforceCreditGate(job('tg_message'))).toBe('allowed');
    });

    it('blocks a non-comped athlete at $0 — alerts David and messages them', async () => {
      getCreditState.mockResolvedValue({ balanceCents: 0, comped: false });
      expect(await enforceCreditGate(job('daily_checkin'))).toBe('blocked');
      expect(sendDavidAlert).toHaveBeenCalledTimes(1);
      expect(sendReply).toHaveBeenCalledWith(ATHLETE, expect.stringContaining('/buy'));
    });

    it('blocks a non-comped athlete who overshot into the negative', async () => {
      getCreditState.mockResolvedValue({ balanceCents: -50, comped: false });
      expect(await enforceCreditGate(job('daily_checkin'))).toBe('blocked');
    });

    it('fails open and alerts David when the balance read throws', async () => {
      getCreditState.mockRejectedValue(new Error('db down'));
      expect(await enforceCreditGate(job('daily_checkin'))).toBe('allowed');
      expect(sendDavidAlert).toHaveBeenCalledTimes(1);
    });

    it('fails open when there is no billing row', async () => {
      getCreditState.mockResolvedValue(null);
      expect(await enforceCreditGate(job('daily_checkin'))).toBe('allowed');
      expect(sendDavidAlert).toHaveBeenCalledTimes(1);
    });

    it('allows (defers to dispatch) when the payload has no athlete id', async () => {
      expect(await enforceCreditGate({ kind: 'daily_checkin', payload: {} })).toBe('allowed');
      expect(getCreditState).not.toHaveBeenCalled();
    });
  });
});
