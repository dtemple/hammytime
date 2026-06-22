import { describe, it, expect } from 'vitest';
import { BILLING_MARKUP, billedCents } from './pricing';

describe('billedCents — cost_usd × markup → whole cents', () => {
  it('applies the 1.5× markup and rounds to whole cents', () => {
    // $0.53 raw → $0.795 billed → 79.5¢ → 80¢ (round half up).
    expect(billedCents(0.53)).toBe(80);
    // $0.40 raw → $0.60 billed → exactly 60¢.
    expect(billedCents(0.4)).toBe(60);
  });

  it('rounds a tiny cost down to zero cents', () => {
    // $0.001 raw → 0.15¢ → 0¢. chargeRun skips a 0¢ debit (no noise row).
    expect(billedCents(0.001)).toBe(0);
  });

  it('handles a large/overshoot run — the debit that can push a balance negative', () => {
    // The MAX_BUDGET_USD ($1) ceiling case: $1.00 raw → $1.50 billed → 150¢.
    // A friend with 100¢ left lands at -50¢; the gate refuses the *next* run.
    expect(billedCents(1)).toBe(150);
  });

  it('treats non-positive or non-finite cost as zero', () => {
    expect(billedCents(0)).toBe(0);
    expect(billedCents(-1)).toBe(0);
    expect(billedCents(NaN)).toBe(0);
  });

  it('keeps the markup as the single editable knob', () => {
    expect(BILLING_MARKUP).toBe(1.5);
  });
});
