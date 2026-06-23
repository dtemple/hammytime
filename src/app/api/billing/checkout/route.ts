import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createTopupSession } from '@/server/billing/checkout';
import { isPresetCents } from '@/server/billing/pricing';

/**
 * Create-a-top-up-Checkout-Session endpoint (Specs/METERING_PAYMENTS.md §6).
 *
 * POST { athlete_id, amount_cents } → { url } — the Stripe hosted-page link the
 * caller hands the friend. Step 4 (the /buy bot command) is the real caller; for
 * now it's exercised by scripts/verify-stripe.ts.
 *
 * Unauthenticated by design for step 3: minting a session for any athlete only
 * ever results in someone PAYING to credit that athlete's balance, so there's no
 * abuse to gate. The amount is constrained to the presets and the athlete must
 * exist. Lock this down (bot-shared secret / session cookie) if it ever fronts
 * something costlier.
 */
export async function POST(req: NextRequest) {
  let body: { athlete_id?: unknown; amount_cents?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const athleteId = body.athlete_id;
  const amountCents = body.amount_cents;

  if (typeof athleteId !== 'string' || !athleteId) {
    return NextResponse.json({ error: 'athlete_id required' }, { status: 400 });
  }
  if (typeof amountCents !== 'number' || !isPresetCents(amountCents)) {
    return NextResponse.json({ error: 'amount_cents must be a top-up preset' }, { status: 400 });
  }

  try {
    const url = await createTopupSession(athleteId, amountCents);
    return NextResponse.json({ url });
  } catch (err) {
    Sentry.captureException(err);
    return NextResponse.json({ error: 'failed to create checkout session' }, { status: 500 });
  }
}
