// Verification + manual-test harness for METERING_PAYMENTS §6/§11 (step 3) —
// the Stripe Checkout top-up + dashboard-refund ledger path. Runs against
// whatever .env.local points at (PROD).
//
// Modes:
//   (no args)                          DB-level suite: a throwaway athlete
//                                      exercises every apply_stripe_credit path,
//                                      then is deleted. No Stripe keys needed.
//   --throwaway [amount_cents]         Create a throwaway athlete (+$5 grant) and
//                                      mint a real test-mode Checkout Session for
//                                      it. Prints the URL + the follow-up commands.
//   --mint <athlete_id> [amount_cents] Mint a session for an EXISTING athlete.
//   --balance <athlete_id>             Print balance + the full ledger.
//   --cleanup <athlete_id>             Delete an athlete (credits + ledger cascade).
//
// The mint/throwaway modes hit the real Stripe test API (needs STRIPE_SECRET_KEY)
// and let you complete a payment with card 4242 4242 4242 4242 to prove the live
// webhook → ledger path. amount_cents must be a preset (1000 / 2500 / 5000).
//
//   npx tsx scripts/verify-stripe.ts                       # DB suite
//   npx tsx scripts/verify-stripe.ts --throwaway 2500      # end-to-end test
//   npx tsx scripts/verify-stripe.ts --balance <id>
//   npx tsx scripts/verify-stripe.ts --cleanup <id>

import { config } from 'dotenv';
config({ path: '.env.local' });

import { supabaseAdmin } from '@/lib/db';
import {
  grantSignupCredit,
  getCreditState,
  recordStripeTopup,
  recordStripeRefund,
} from '@/server/billing/credits';
import { storeStripeCustomerId, createTopupSession } from '@/server/billing/checkout';
import { DEFAULT_TOPUP_CENTS, dollarsLabel, isPresetCents } from '@/server/billing/pricing';

const db = supabaseAdmin();

// ===========================================================================
// DB-level verification suite (default, self-cleaning — no Stripe keys needed)
// ===========================================================================
async function runVerification() {
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  const check = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? '✅' : '❌'} ${name} — ${detail}`);
  };

  let athleteId = '';
  const balance = async () => (await getCreditState(athleteId))?.balanceCents ?? NaN;
  const ledgerSum = async () => {
    const { data } = await db.from('credit_ledger').select('amount_cents').eq('athlete_id', athleteId);
    return (data ?? []).reduce((a, r) => a + (r.amount_cents as number), 0);
  };
  const rowsFor = async (pi: string, kind: string) => {
    const { data } = await db
      .from('credit_ledger')
      .select('amount_cents, kind, stripe_payment_intent')
      .eq('stripe_payment_intent', pi)
      .eq('kind', kind);
    return data ?? [];
  };

  try {
    const { data: a, error } = await db
      .from('athletes')
      .insert({ name: 'verify-stripe (throwaway)' })
      .select('id')
      .single();
    if (error || !a) throw new Error(`athlete insert failed: ${error?.message}`);
    athleteId = a.id;
    console.log(`throwaway athlete ${athleteId}\n`);

    await grantSignupCredit(athleteId);
    check('grant sets balance to 500¢', (await balance()) === 500, `balance=${await balance()}`);

    await db
      .from('athlete_credits')
      .update({ low_balance_warned_at: new Date().toISOString() })
      .eq('athlete_id', athleteId);

    // ---- 1. a topup credits the GROSS, balance rises, one row ---------------
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

    // ---- 2. replayed topup is a no-op (idempotent on pi+kind) ---------------
    const balBeforeReplay = await balance();
    const t2 = await recordStripeTopup(athleteId, piTopup, 2500);
    check('replay topup returns false', t2 === false, 'same pi');
    check('balance unchanged after replay', (await balance()) === balBeforeReplay, `balance=${await balance()}`);
    check('still exactly one topup row', (await rowsFor(piTopup, 'topup')).length === 1, 'no dup');

    // ---- 3. a refund of the SAME pi drops the balance, coexists -------------
    const r1 = await recordStripeRefund(athleteId, piTopup, 2500);
    check('refund returns true (same pi as topup)', r1 === true, '$25 back');
    check('balance dropped by the refund', (await balance()) === 500, `balance=${await balance()}`);
    const refundRows = await rowsFor(piTopup, 'refund');
    check(
      'exactly one refund row = −refunded cents',
      refundRows.length === 1 && refundRows[0]?.amount_cents === -2500,
      JSON.stringify(refundRows),
    );

    // ---- 4. replayed refund is a no-op --------------------------------------
    const balBeforeRefundReplay = await balance();
    const r2 = await recordStripeRefund(athleteId, piTopup, 2500);
    check('replay refund returns false', r2 === false, 'same pi');
    check('balance unchanged after refund replay', (await balance()) === balBeforeRefundReplay, `balance=${await balance()}`);

    // ---- balance reconstructs from the ledger -------------------------------
    const bal = await balance();
    const sum = await ledgerSum();
    check('balance_cents == sum(ledger.amount_cents)', bal === sum, `balance=${bal} ledgerSum=${sum}`);

    // ---- 5. customer id storage ---------------------------------------------
    await storeStripeCustomerId(athleteId, 'cus_verify_123');
    const { data: cred } = await db
      .from('athlete_credits')
      .select('stripe_customer_id')
      .eq('athlete_id', athleteId)
      .maybeSingle();
    check('stripe_customer_id stored', cred?.stripe_customer_id === 'cus_verify_123', `cus=${cred?.stripe_customer_id}`);
  } finally {
    if (athleteId) {
      await db.from('athletes').delete().eq('id', athleteId);
      console.log(`\ncleaned up throwaway athlete ${athleteId}`);
    }
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

// ===========================================================================
// Manual-test modes (hit the real Stripe test API)
// ===========================================================================
function parseAmount(v: string | undefined): number {
  if (v == null) return DEFAULT_TOPUP_CENTS;
  const n = Number(v);
  if (!Number.isFinite(n) || !isPresetCents(n)) {
    throw new Error(`amount "${v}" is not a preset (1000 / 2500 / 5000)`);
  }
  return n;
}

async function mint(athleteId: string, amountCents: number) {
  const url = await createTopupSession(athleteId, amountCents);
  console.log(`\nCheckout for athlete ${athleteId} (${dollarsLabel(amountCents)}):\n  ${url}\n`);
  console.log('Pay with test card 4242 4242 4242 4242 — any future expiry, any CVC/ZIP.');
  console.log('Then check the balance + ledger:');
  console.log(`  npx tsx scripts/verify-stripe.ts --balance ${athleteId}`);
}

async function mintThrowaway(amountCents: number) {
  const { data, error } = await db
    .from('athletes')
    .insert({ name: 'verify-stripe mint (throwaway)' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`athlete insert failed: ${error?.message}`);
  const id = data.id;
  await grantSignupCredit(id); // creates the credits row at 500¢
  console.log(`throwaway athlete ${id} (granted $5 → 500¢ before topup)`);
  await mint(id, amountCents);
  console.log('\nAfter verifying, delete it (cascades credits + ledger):');
  console.log(`  npx tsx scripts/verify-stripe.ts --cleanup ${id}`);
}

async function showBalance(athleteId: string) {
  const s = await getCreditState(athleteId);
  if (!s) {
    console.log(`no billing row for athlete ${athleteId}`);
    return;
  }
  console.log(
    `athlete ${athleteId}: balance ${s.balanceCents}¢ (${dollarsLabel(s.balanceCents)}), comped=${s.comped}`,
  );
  const { data } = await db
    .from('credit_ledger')
    .select('kind, amount_cents, balance_after_cents, stripe_payment_intent, created_at')
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: true });
  for (const r of data ?? []) {
    const amt = `${r.amount_cents as number}¢`.padStart(8);
    console.log(
      `  ${r.created_at}  ${String(r.kind).padEnd(6)} ${amt}  → ${r.balance_after_cents}¢  ${r.stripe_payment_intent ?? ''}`,
    );
  }
}

async function cleanup(athleteId: string) {
  await db.from('athletes').delete().eq('id', athleteId);
  console.log(`deleted athlete ${athleteId} (credits + ledger cascade)`);
}

// ===========================================================================
// Dispatch
// ===========================================================================
const [cmd, arg1, arg2] = process.argv.slice(2);

(async () => {
  switch (cmd) {
    case undefined:
      await runVerification();
      break;
    case '--throwaway':
      await mintThrowaway(parseAmount(arg1));
      break;
    case '--mint':
      if (!arg1) throw new Error('usage: --mint <athlete_id> [amount_cents]');
      await mint(arg1, parseAmount(arg2));
      break;
    case '--balance':
      if (!arg1) throw new Error('usage: --balance <athlete_id>');
      await showBalance(arg1);
      break;
    case '--cleanup':
      if (!arg1) throw new Error('usage: --cleanup <athlete_id>');
      await cleanup(arg1);
      break;
    default:
      throw new Error(`unknown command "${cmd}" — see the header for usage`);
  }
})().catch((e) => {
  console.error('error:', e);
  process.exitCode = 1;
});
