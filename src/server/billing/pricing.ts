// Metering & payments — the one place the billing markup lives.
//
// Specs/METERING_PAYMENTS.md §2: a friend's balance is real dollars they paid; a
// run that costs us `cost_usd` of model time draws down `cost_usd × markup`. The
// 0.5× over raw covers Stripe fees + hosting, not profit (§1, disclosed).
//
// This module is imported by BOTH surfaces — the worker (per-run debit) and the
// web app (burn-rate / runway / balance display in later steps) — so the markup
// is defined exactly once. Cents are computed here, not in SQL, so there is no
// second copy of the number in the database.

// ===========================================================================
// THE KNOB. This is the only place to change the markup. Editing it changes how
// fast every friend's credit draws down. Expect to tune it as costs and pricing
// move (caching wins, Sonnet routing, etc.). After changing it, redeploy BOTH
// surfaces together — web (git push) and worker (fly deploy) — so they never
// disagree on what a run costs.
// ===========================================================================
export const BILLING_MARKUP = 1.5;

/**
 * The cents to debit for a run that cost `costUsd` of raw model time, at the
 * current markup. Rounded to whole cents (no fractional money). Always >= 0;
 * a non-positive cost yields 0.
 *
 * round(cost × markup × 100) — the single rounding rule shared by worker and web.
 */
export function billedCents(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  return Math.round(costUsd * BILLING_MARKUP * 100);
}

// ===========================================================================
// TOP-UP PRESETS (§1, §6). The single source of truth for the buyable amounts,
// shared by the create-session route and (later step) the /buy bot buttons.
// Ordered low→high; $25 is the default. Change here only.
// ===========================================================================
export const TOPUP_PRESETS_CENTS = [1000, 2500, 5000] as const;
export const DEFAULT_TOPUP_CENTS = 2500;

/** True if `cents` is one of the buyable presets. The route rejects anything else. */
export function isPresetCents(cents: number): boolean {
  return (TOPUP_PRESETS_CENTS as readonly number[]).includes(cents);
}

/** "$25" / "$7.50" — dollar label for a cent amount (line items, confirmations). */
export function dollarsLabel(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
