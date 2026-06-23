import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/db';
import { stripe } from '@/server/billing/stripe';
import { recordStripeTopup, recordStripeRefund } from '@/server/billing/credits';
import { storeStripeCustomerId } from '@/server/billing/checkout';

/**
 * Stripe webhook receiver (Specs/METERING_PAYMENTS.md §6, §11).
 *
 *   checkout.session.completed → credit the GROSS amount paid as a kind='topup'
 *     ledger row + balance bump (clears low_balance_warned_at, §8). Idempotent on
 *     the payment_intent.
 *   charge.refunded → mirror a dashboard-issued refund as a kind='refund' row +
 *     balance decrement. Idempotent on the payment_intent.
 *   anything else → 200, no-op.
 *
 * Signature is verified against STRIPE_WEBHOOK_SECRET using the RAW request body
 * (req.text(), never JSON.parse first — the signature is over the exact bytes).
 * A bad/missing signature is a 400. A handler error is a 500 so Stripe retries
 * (the RPCs are idempotent, so a retry can't double-apply).
 */

// Stripe "expandable" fields arrive as either the id string or the nested object
// (we never expand, so it's the id). Collapse both to the id.
function idOf(field: string | { id: string } | null | undefined): string | null {
  return typeof field === 'string' ? field : (field?.id ?? null);
}

// Read the raw body for signature verification. App Router hands us the
// unparsed request, so req.text() is the exact bytes Stripe signed.
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    Sentry.captureException(new Error('Missing STRIPE_WEBHOOK_SECRET'));
    return new NextResponse('not configured', { status: 500 });
  }

  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(body, sig ?? '', secret);
  } catch (err) {
    // Bad or missing signature — reject. Do not process.
    return new NextResponse(`signature verification failed: ${(err as Error).message}`, {
      status: 400,
    });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'charge.refunded':
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        break;
      default:
        // Unhandled event type — acknowledge and ignore.
        break;
    }
  } catch (err) {
    // Let Stripe retry; the RPCs are idempotent on payment_intent.
    Sentry.captureException(err);
    return new NextResponse('handler error', { status: 500 });
  }

  return new NextResponse('ok', { status: 200 });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  // Only credit a session that actually paid.
  if (session.payment_status !== 'paid') return;

  // client_reference_id ties the session to the athlete. NB: this is
  // Checkout-Session-specific — step 6's off-session auto-reload PaymentIntents
  // have no Checkout Session, so their completion will key on
  // payment_intent_data.metadata.athlete_id instead (set in createTopupSession).
  const athleteId = session.client_reference_id;
  const paymentIntent = idOf(session.payment_intent);
  const grossCents = session.amount_total;

  if (!athleteId || !paymentIntent || grossCents == null) {
    // Not one of ours, or malformed — ack so Stripe stops retrying.
    console.warn(
      `[stripe] checkout.session.completed missing fields (athlete=${athleteId}, pi=${paymentIntent}, total=${grossCents}) — skipped`,
    );
    return;
  }

  // Backstop: persist the customer id if it isn't stored yet (we normally store
  // it when creating the session).
  const customerId = idOf(session.customer);
  if (customerId) await storeStripeCustomerId(athleteId, customerId);

  const credited = await recordStripeTopup(athleteId, paymentIntent, grossCents);
  if (!credited) {
    console.info(`[stripe] topup ${paymentIntent} already recorded — replay no-op`);
  }
}

async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const paymentIntent = idOf(charge.payment_intent);
  if (!paymentIntent) return;

  // amount_refunded is the cumulative cents refunded on this charge. v1 mirrors
  // it once per charge (idempotent on payment_intent+kind=refund); a SECOND
  // partial refund on the same charge is deduped and dropped — accepted v1
  // limitation (§11; friends, full refunds from the dashboard).
  const refundedCents = charge.amount_refunded;
  if (!refundedCents || refundedCents <= 0) return;

  // Resolve the athlete from the original topup row, not from charge metadata —
  // the topup row already ties this payment_intent to an athlete.
  const { data: topup, error } = await supabaseAdmin()
    .from('credit_ledger')
    .select('athlete_id')
    .eq('stripe_payment_intent', paymentIntent)
    .eq('kind', 'topup')
    .maybeSingle();
  if (error) throw error;
  if (!topup) {
    console.warn(`[stripe] charge.refunded for pi ${paymentIntent} with no topup row — skipped`);
    return;
  }

  const refunded = await recordStripeRefund(topup.athlete_id, paymentIntent, refundedCents);
  if (!refunded) {
    console.info(`[stripe] refund ${paymentIntent} already recorded — replay no-op`);
  }
}
