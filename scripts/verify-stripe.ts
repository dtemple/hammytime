// DB-level verification for METERING_PAYMENTS §6/§11 (step 3) — the topup/refund
// ledger mechanics behind the Stripe webhook. Runs against whatever .env.local
// points at (PROD). Creates a THROWAWAY athlete, exercises every apply_stripe_credit
// path with real rows, then deletes the athlete — the FK cascade wipes its
// athlete_credits + credit_ledger rows, so prod is left exactly as found.
//
// This needs NO Stripe keys — it calls the RPC wrappers directly, proving the
// idempotency + balance + reconstruction the webhook relies on. The full Stripe
// path (signature verify, real session, replay via `stripe trigger`, bad-sig 400)
// is the manual Stripe-CLI checklist in the step-3 summary.
//
//   npx tsx scripts/verify-stripe.ts

import { config } from 'dotenv';
config({ path: '.env.local' });

import { supabaseAdmin } from '@/lib/db';
import {
  grantSignupCredit,
  getCreditState,
  recordStripeTopup,
  recordStripeRefund,
} from '@/server/billing/credits';
import { storeStripeCustomerId } from '@/server/billing/checkout';

const db = supabaseAdmin();
let athleteId = '';
const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

function check(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name} — ${detail}`);
}

async function balance(): Promise<number> {
  const s = await getCreditState(athleteId);
  return s?.balanceCents ?? NaN;
}

async function ledgerSum(): Promise<number> {
  const { data } = await db.from('credit_ledger').select('amount_cents').eq('athlete_id', athleteId);
  return (data ?? []).reduce((a, r) => a + (r.amount_cents as number), 0);
}

async function rowsFor(pi: string, kind: string) {
  const { data } = await db
    .from('credit_ledger')
    .select('amount_cents, kind, stripe_payment_intent')
    .eq('stripe_payment_intent', pi)
    .eq('kind', kind);
  return data ?? [];
}

async function main() {
  const { data: a, error } = await db
    .from('athletes')
    .insert({ name: 'verify-stripe (throwaway)' })
    .select('id')
    .single();
  if (error || !a) throw new Error(`athlete insert failed: ${error?.message}`);
  athleteId = a.id;
  console.log(`throwaway athlete ${athleteId}\n`);

  // Signup grant creates the credits row at 500¢.
  await grantSignupCredit(athleteId);
  check('grant sets balance to 500¢', (await balance()) === 500, `balance=${await balance()}`);

  // Arm the low-balance warning so we can prove a topup clears it (§8).
  await db
    .from('athlete_credits')
    .update({ low_balance_warned_at: new Date().toISOString() })
    .eq('athlete_id', athleteId);

  // ---- 1. a topup credits the GROSS, balance rises, one row -----------------
  const piTopup = 'pi_verify_topup_1';
  const t1 = await recordStripeTopup(athleteId, piTopup, 2500);
  check('topup returns true', t1 === true, '$25');
  check('balance rose by the gross', (await balance()) === 3000, `balance=${await balance()}`);
  const topupRows = await rowsFor(piTopup, 'topup');
  check(
    'exactly one topup row = +gross cents',
    topupRows.length === 1 && topupRows[0]?.amount_cents === 2500,
    JSON.stringify(topupRows),
  );

  // low_balance_warned_at cleared by the topup
  const { data: credAfterTopup } = await db
    .from('athlete_credits')
    .select('low_balance_warned_at')
    .eq('athlete_id', athleteId)
    .maybeSingle();
  check(
    'topup cleared low_balance_warned_at (§8)',
    credAfterTopup?.low_balance_warned_at == null,
    `warned_at=${credAfterTopup?.low_balance_warned_at}`,
  );

  // ---- 2. replayed topup is a no-op (idempotent on pi+kind) -----------------
  const balBeforeReplay = await balance();
  const t2 = await recordStripeTopup(athleteId, piTopup, 2500);
  check('replay topup returns false', t2 === false, 'same pi');
  check('balance unchanged after replay', (await balance()) === balBeforeReplay, `balance=${await balance()}`);
  check('still exactly one topup row', (await rowsFor(piTopup, 'topup')).length === 1, 'no dup');

  // ---- 3. a refund of the SAME pi drops the balance, coexists with the topup -
  const r1 = await recordStripeRefund(athleteId, piTopup, 2500);
  check('refund returns true (same pi as topup)', r1 === true, '$25 back');
  check('balance dropped by the refund', (await balance()) === 500, `balance=${await balance()}`);
  const refundRows = await rowsFor(piTopup, 'refund');
  check(
    'exactly one refund row = −refunded cents',
    refundRows.length === 1 && refundRows[0]?.amount_cents === -2500,
    JSON.stringify(refundRows),
  );

  // ---- 4. replayed refund is a no-op ----------------------------------------
  const balBeforeRefundReplay = await balance();
  const r2 = await recordStripeRefund(athleteId, piTopup, 2500);
  check('replay refund returns false', r2 === false, 'same pi');
  check('balance unchanged after refund replay', (await balance()) === balBeforeRefundReplay, `balance=${await balance()}`);

  // ---- balance reconstructs from the ledger ---------------------------------
  const bal = await balance();
  const sum = await ledgerSum();
  check('balance_cents == sum(ledger.amount_cents)', bal === sum, `balance=${bal} ledgerSum=${sum}`);

  // ---- 5. customer id storage (the on-first-purchase store) ------------------
  await storeStripeCustomerId(athleteId, 'cus_verify_123');
  const { data: cred } = await db
    .from('athlete_credits')
    .select('stripe_customer_id')
    .eq('athlete_id', athleteId)
    .maybeSingle();
  check('stripe_customer_id stored', cred?.stripe_customer_id === 'cus_verify_123', `cus=${cred?.stripe_customer_id}`);
}

main()
  .catch((e) => {
    console.error('verification error:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (athleteId) {
      await db.from('athletes').delete().eq('id', athleteId);
      console.log(`\ncleaned up throwaway athlete ${athleteId}`);
    }
    const failed = checks.filter((c) => !c.pass);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length) process.exitCode = 1;
  });
