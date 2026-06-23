// Metering & payments — dynamic Stripe Checkout Session creation (§6).
//
// Builds a per-athlete, per-amount Checkout Session (NOT a static Payment Link)
// so we get attribution (client_reference_id), variable amounts, and a stored
// customer. mode: 'payment', single line item, no card-saving — setup_future_usage
// is deferred to step 6 (auto-reload). The session URL is handed to the friend as
// a plain https link; the webhook (route.ts) credits the balance on completion.

import { supabaseAdmin } from '@/lib/db';
import { appBaseUrl } from '@/lib/calendar-token';
import { stripe } from './stripe';
import { dollarsLabel, isPresetCents } from './pricing';

/**
 * Store the athlete's Stripe customer id on athlete_credits (idempotent upsert).
 * Used both when we first create the customer and as a backstop in the webhook.
 */
export async function storeStripeCustomerId(
  athleteId: string,
  customerId: string,
): Promise<void> {
  await supabaseAdmin()
    .from('athlete_credits')
    .upsert(
      { athlete_id: athleteId, stripe_customer_id: customerId, updated_at: new Date().toISOString() },
      { onConflict: 'athlete_id' },
    );
}

/**
 * Return the athlete's Stripe customer id, creating + storing one on first use.
 * The customer carries our athlete_id in metadata so the Stripe dashboard maps
 * back to a friend.
 */
async function ensureStripeCustomer(athleteId: string): Promise<string> {
  const db = supabaseAdmin();

  const { data: credits, error } = await db
    .from('athlete_credits')
    .select('stripe_customer_id')
    .eq('athlete_id', athleteId)
    .maybeSingle();
  if (error) throw error;
  if (credits?.stripe_customer_id) return credits.stripe_customer_id;

  const { data: athlete, error: aErr } = await db
    .from('athletes')
    .select('id, name')
    .eq('id', athleteId)
    .maybeSingle();
  if (aErr) throw aErr;
  if (!athlete) throw new Error(`athlete ${athleteId} not found`);

  const customer = await stripe().customers.create({
    name: athlete.name,
    metadata: { athlete_id: athleteId },
  });
  await storeStripeCustomerId(athleteId, customer.id);
  return customer.id;
}

/**
 * Create a top-up Checkout Session for `athleteId` of `amountCents` (must be a
 * preset, §1). Returns the hosted-page URL. Throws on a non-preset amount, an
 * unknown athlete, or a missing Stripe key.
 */
export async function createTopupSession(
  athleteId: string,
  amountCents: number,
): Promise<string> {
  if (!isPresetCents(amountCents)) {
    throw new Error(`amount ${amountCents}¢ is not a top-up preset`);
  }

  const customerId = await ensureStripeCustomer(athleteId);

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    client_reference_id: athleteId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: { name: `Daybreak coaching credit — ${dollarsLabel(amountCents)}` },
        },
      },
    ],
    // Attribution on both the session (for checkout.session.completed) and the
    // PaymentIntent (visible on the charge in the dashboard). No setup_future_usage —
    // card-saving is step 6 (auto-reload).
    metadata: { athlete_id: athleteId, kind: 'topup' },
    payment_intent_data: { metadata: { athlete_id: athleteId, kind: 'topup' } },
    success_url: `${appBaseUrl()}/checkout/success`,
    cancel_url: `${appBaseUrl()}/?checkout=cancelled`,
  });

  if (!session.url) throw new Error('Stripe returned a session with no url');
  return session.url;
}
