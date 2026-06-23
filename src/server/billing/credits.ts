// Metering & payments — credit grant helper (Specs/METERING_PAYMENTS.md §4, step 1).
//
// Thin wrapper over the grant_signup_credit RPC. The RPC owns idempotency and the
// ledger+balance write; this just calls it and maps the result. No draw-down,
// Stripe, or gate here — those are later steps.

import { supabaseAdmin } from '@/lib/db';

/** $5 free credit, once per athlete. Locked policy (§1). */
export const SIGNUP_GRANT_CENTS = 500;

/**
 * Grant the one-time signup credit to an athlete. Idempotent — a second call for
 * the same athlete is a no-op (enforced in the DB). Returns true if this call
 * wrote the grant, false if the athlete already had one.
 *
 * Writes the ledger row (source of truth) and the balance cache in one
 * transaction inside the RPC.
 */
export async function grantSignupCredit(athleteId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('grant_signup_credit', {
    p_athlete_id: athleteId,
    p_amount_cents: SIGNUP_GRANT_CENTS,
  });
  if (error) throw error;
  return data === true;
}

/**
 * Debit a persisted run from the athlete's balance (Specs/METERING_PAYMENTS.md
 * §5). `amountCents` is the positive billed amount (compute it with
 * billedCents() from ./pricing); the RPC writes a signed-negative kind='debit'
 * ledger row referencing the run and decrements the balance, in one transaction.
 *
 * Idempotent on the run: a second call for the same run is a no-op (DB partial
 * unique index). Comped athletes are a no-op too. Returns true if this call
 * debited, false on a skip (comped or already debited).
 */
export async function debitRunCredit(
  athleteId: string,
  runId: string,
  amountCents: number,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('debit_run_credit', {
    p_athlete_id: athleteId,
    p_run_id: runId,
    p_amount_cents: amountCents,
  });
  if (error) throw error;
  return data === true;
}

/**
 * Mirror a Stripe money event into the ledger + balance (Specs/METERING_PAYMENTS.md
 * §6, §11). One parameterized RPC handles both directions; `amountCents` is SIGNED
 * (+ for a topup, − for a refund) and the RPC bumps the balance by it and clears
 * low_balance_warned_at on a topup. Prefer recordStripeTopup/recordStripeRefund
 * below, which own the sign.
 *
 * Idempotent on (payment_intent, kind): a replayed webhook is a no-op (DB partial
 * unique index). Returns true if this call wrote the row, false on a replay.
 */
export async function applyStripeCredit(
  athleteId: string,
  paymentIntent: string,
  amountCents: number,
  kind: 'topup' | 'refund',
): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('apply_stripe_credit', {
    p_athlete_id: athleteId,
    p_payment_intent: paymentIntent,
    p_amount_cents: amountCents,
    p_kind: kind,
  });
  if (error) throw error;
  return data === true;
}

/** Credit the GROSS amount a friend paid (§1, §6). `grossCents` is the positive
 *  amount_total from the Checkout session; the fee is absorbed by the buffer. */
export function recordStripeTopup(
  athleteId: string,
  paymentIntent: string,
  grossCents: number,
): Promise<boolean> {
  return applyStripeCredit(athleteId, paymentIntent, Math.abs(grossCents), 'topup');
}

/** Mirror a dashboard-issued refund back to the balance (§11). `refundedCents` is
 *  the positive amount_refunded; stored signed-negative and decremented. */
export function recordStripeRefund(
  athleteId: string,
  paymentIntent: string,
  refundedCents: number,
): Promise<boolean> {
  return applyStripeCredit(athleteId, paymentIntent, -Math.abs(refundedCents), 'refund');
}

export type CreditState = { balanceCents: number; comped: boolean };

/**
 * Read an athlete's live balance + comp flag from the cache (athlete_credits).
 * Returns null when there's no row — the caller decides how to treat a missing
 * billing row (the §5 gate fails open). Used by the pre-run gate; the web
 * `/balance` surface (later step) reuses it.
 */
export async function getCreditState(athleteId: string): Promise<CreditState | null> {
  const { data, error } = await supabaseAdmin()
    .from('athlete_credits')
    .select('balance_cents, comped')
    .eq('athlete_id', athleteId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { balanceCents: data.balance_cents, comped: data.comped };
}
