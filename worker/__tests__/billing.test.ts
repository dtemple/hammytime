// Unit tests for the worker's metering orchestration (worker/billing.ts).
// billedCents (pure) is real; the atomic debit / balance read (credits.ts) and
// the Telegram surface (send.ts) are mocked. The RPCs' DB behavior is verified
// live against the DB — see the verification output.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  debitRunCredit,
  getCreditState,
  getLowBalanceWarnState,
  markLowBalanceWarned,
  hasToppedUp,
  estimateRunwayDays,
  sendDavidAlert,
  sendReply,
  sendTopupButtons,
} = vi.hoisted(() => ({
  debitRunCredit: vi.fn(),
  getCreditState: vi.fn(),
  getLowBalanceWarnState: vi.fn(),
  markLowBalanceWarned: vi.fn(),
  hasToppedUp: vi.fn(),
  estimateRunwayDays: vi.fn(),
  sendDavidAlert: vi.fn(),
  sendReply: vi.fn(),
  sendTopupButtons: vi.fn(),
}));
vi.mock('@/server/billing/credits', () => ({
  debitRunCredit,
  getCreditState,
  getLowBalanceWarnState,
  markLowBalanceWarned,
  hasToppedUp,
}));
// estimateRunwayDays reads the rollup (DB) — mock it; runwayLabel is pure, keep it
// real so the heads-up copy asserts against the actual rendered runway phrase.
vi.mock('@/server/billing/burn-rate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/billing/burn-rate')>()),
  estimateRunwayDays,
}));
vi.mock('../send', () => ({ sendDavidAlert, sendReply, sendTopupButtons }));

import { chargeRun, enforceCreditGate, maybeWarnLowBalance } from '../billing';

const ATHLETE = '11111111-2222-3333-4444-555555555555';
const job = (kind: string, athleteId: string = ATHLETE) => ({
  kind,
  payload: { athlete_id: athleteId },
});

beforeEach(() => {
  debitRunCredit.mockReset().mockResolvedValue(true);
  getCreditState.mockReset();
  getLowBalanceWarnState.mockReset();
  markLowBalanceWarned.mockReset().mockResolvedValue(undefined);
  hasToppedUp.mockReset().mockResolvedValue(false);
  estimateRunwayDays.mockReset().mockResolvedValue(99);
  sendDavidAlert.mockReset().mockResolvedValue(undefined);
  sendReply.mockReset().mockResolvedValue(undefined);
  sendTopupButtons.mockReset().mockResolvedValue(undefined);
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
    expect(sendTopupButtons).not.toHaveBeenCalled();
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
      expect(sendTopupButtons).not.toHaveBeenCalled();
    });

    it('allows a non-comped athlete with a positive balance', async () => {
      getCreditState.mockResolvedValue({ balanceCents: 1, comped: false });
      expect(await enforceCreditGate(job('tg_message'))).toBe('allowed');
    });

    it('blocks a non-comped athlete at $0 — alerts David and messages them with buttons', async () => {
      getCreditState.mockResolvedValue({ balanceCents: 0, comped: false });
      expect(await enforceCreditGate(job('daily_checkin'))).toBe('blocked');
      expect(sendDavidAlert).toHaveBeenCalledTimes(1);
      expect(sendTopupButtons).toHaveBeenCalledWith(
        ATHLETE,
        expect.stringContaining('last of your credit'),
      );
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

describe('maybeWarnLowBalance — §8 low-balance heads-up', () => {
  // A positive balance whose runway sits at/under the 2-day threshold.
  const low = (over: Partial<{ comped: boolean; warnedAt: string | null }> = {}) =>
    ({ balanceCents: 120, comped: false, warnedAt: null, ...over });

  it('is OFF by default — never reads or sends in the free era', async () => {
    getLowBalanceWarnState.mockResolvedValue(low());
    estimateRunwayDays.mockResolvedValue(1.5);
    await maybeWarnLowBalance(ATHLETE);
    expect(getLowBalanceWarnState).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
    expect(markLowBalanceWarned).not.toHaveBeenCalled();
  });

  describe('with BILLING_GATE_ENABLED on', () => {
    beforeEach(() => {
      process.env.BILLING_GATE_ENABLED = 'true';
    });

    it('fires the first-time explainer (never topped up) as plain text, then marks', async () => {
      getLowBalanceWarnState.mockResolvedValue(low());
      estimateRunwayDays.mockResolvedValue(1.5);
      hasToppedUp.mockResolvedValue(false);
      await maybeWarnLowBalance(ATHLETE);
      expect(sendReply).toHaveBeenCalledWith(
        ATHLETE,
        expect.stringContaining('runs on a credits system'),
      );
      expect(sendTopupButtons).not.toHaveBeenCalled(); // no buttons on the heads-up
      expect(markLowBalanceWarned).toHaveBeenCalledWith(ATHLETE);
    });

    it('fires the short version once the athlete has topped up before', async () => {
      getLowBalanceWarnState.mockResolvedValue(low());
      estimateRunwayDays.mockResolvedValue(1.5);
      hasToppedUp.mockResolvedValue(true);
      await maybeWarnLowBalance(ATHLETE);
      expect(sendReply).toHaveBeenCalledWith(ATHLETE, expect.stringContaining('Quick heads-up'));
      expect(markLowBalanceWarned).toHaveBeenCalledWith(ATHLETE);
    });

    it('renders the dynamic runway + dollar amount in the copy', async () => {
      getLowBalanceWarnState.mockResolvedValue(low());
      estimateRunwayDays.mockResolvedValue(1.5);
      hasToppedUp.mockResolvedValue(true);
      await maybeWarnLowBalance(ATHLETE);
      const text = sendReply.mock.calls[0]?.[1] as string;
      expect(text).toContain('$1.20');
      expect(text).toContain('about 2 days');
    });

    it('marks after the send even if the send fails (still dedupes)', async () => {
      getLowBalanceWarnState.mockResolvedValue(low());
      estimateRunwayDays.mockResolvedValue(1.5);
      sendReply.mockRejectedValue(new Error('telegram down'));
      await maybeWarnLowBalance(ATHLETE);
      expect(markLowBalanceWarned).toHaveBeenCalledWith(ATHLETE);
    });

    it('defaults to the explainer when the top-up history read throws', async () => {
      getLowBalanceWarnState.mockResolvedValue(low());
      estimateRunwayDays.mockResolvedValue(1.5);
      hasToppedUp.mockRejectedValue(new Error('db down'));
      await maybeWarnLowBalance(ATHLETE);
      expect(sendReply).toHaveBeenCalledWith(
        ATHLETE,
        expect.stringContaining('runs on a credits system'),
      );
    });

    it('skips when runway is still above the threshold', async () => {
      getLowBalanceWarnState.mockResolvedValue({ balanceCents: 400, comped: false, warnedAt: null });
      estimateRunwayDays.mockResolvedValue(5);
      await maybeWarnLowBalance(ATHLETE);
      expect(sendReply).not.toHaveBeenCalled();
      expect(markLowBalanceWarned).not.toHaveBeenCalled();
    });

    it('skips a comped athlete', async () => {
      getLowBalanceWarnState.mockResolvedValue(low({ comped: true }));
      await maybeWarnLowBalance(ATHLETE);
      expect(estimateRunwayDays).not.toHaveBeenCalled();
      expect(sendReply).not.toHaveBeenCalled();
    });

    it('skips at $0 — the gate owns that case', async () => {
      getLowBalanceWarnState.mockResolvedValue({ balanceCents: 0, comped: false, warnedAt: null });
      await maybeWarnLowBalance(ATHLETE);
      expect(sendReply).not.toHaveBeenCalled();
    });

    it('skips (dedupe) when already warned this cycle', async () => {
      getLowBalanceWarnState.mockResolvedValue(low({ warnedAt: '2026-06-24T00:00:00Z' }));
      await maybeWarnLowBalance(ATHLETE);
      expect(estimateRunwayDays).not.toHaveBeenCalled();
      expect(sendReply).not.toHaveBeenCalled();
      expect(markLowBalanceWarned).not.toHaveBeenCalled();
    });

    it('skips when there is no billing row', async () => {
      getLowBalanceWarnState.mockResolvedValue(null);
      await maybeWarnLowBalance(ATHLETE);
      expect(sendReply).not.toHaveBeenCalled();
    });

    it('bails quietly when the balance read throws', async () => {
      getLowBalanceWarnState.mockRejectedValue(new Error('db down'));
      await expect(maybeWarnLowBalance(ATHLETE)).resolves.toBeUndefined();
      expect(sendReply).not.toHaveBeenCalled();
    });
  });
});
