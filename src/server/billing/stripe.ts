// Metering & payments — the single initialized Stripe SDK client (§6).
//
// One lazily-constructed client, reused across the create-session route and the
// webhook handler so they share the same pinned API version. Server-only —
// reads STRIPE_SECRET_KEY (test key for now; live key swaps in at launch).

import Stripe from 'stripe';

// Pin the API version so Stripe dashboard upgrades never silently change the
// shape of objects we parse. Matches the version bundled with stripe@22 — bump
// deliberately, alongside an SDK upgrade, never by accident.
export const STRIPE_API_VERSION = '2026-05-27.dahlia';

let client: Stripe | null = null;

/** The shared Stripe client. Throws if STRIPE_SECRET_KEY is unset. */
export function stripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY');
  client = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  return client;
}
