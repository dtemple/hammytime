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
