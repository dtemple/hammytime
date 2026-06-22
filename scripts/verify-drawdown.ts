// One-off verification for METERING_PAYMENTS §5 draw-down + $0 gate (step 2).
//
// Runs against whatever .env.local points at (PROD). It creates a THROWAWAY
// athlete, exercises every RPC path with real rows, then deletes the athlete —
// the FK cascade wipes its athlete_credits + credit_ledger + agent_runs rows, so
// prod is left exactly as found. No model spend, no Telegram (David alerts are
// silenced by unsetting DAVID_TELEGRAM_CHAT_ID before the gate check).
//
//   npx tsx scripts/verify-drawdown.ts

import { config } from 'dotenv';
config({ path: '.env.local' });

import { supabaseAdmin } from '@/lib/db';
import { grantSignupCredit, debitRunCredit, getCreditState } from '@/server/billing/credits';
import { billedCents } from '@/server/billing/pricing';

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

async function newRun(costUsd: number): Promise<string> {
  const { data, error } = await db
    .from('agent_runs')
    .insert({ athlete_id: athleteId, kind: 'daily', model: 'verify', cost_usd: costUsd })
    .select('id')
    .single();
  if (error || !data) throw new Error(`agent_runs insert failed: ${error?.message}`);
  return data.id;
}

async function main() {
  // ---- setup: throwaway athlete + $5 grant ---------------------------------
  const { data: a, error } = await db
    .from('athletes')
    .insert({ name: 'verify-drawdown (throwaway)' })
    .select('id')
    .single();
  if (error || !a) throw new Error(`athlete insert failed: ${error?.message}`);
  athleteId = a.id;
  console.log(`throwaway athlete ${athleteId}\n`);

  await grantSignupCredit(athleteId);
  check('grant sets balance to 500¢', (await balance()) === 500, `balance=${await balance()}`);

  // ---- 1. one debit = round(cost×1.5) cents, balance drops ------------------
  const run1 = await newRun(0.53); // billedCents(0.53) = 80
  const cents1 = billedCents(0.53);
  const d1 = await debitRunCredit(athleteId, run1, cents1);
  check('debit returns true', d1 === true, `cents=${cents1}`);
  check('balance drops by the debit', (await balance()) === 500 - cents1, `balance=${await balance()}`);

  const { data: debitRows } = await db
    .from('credit_ledger')
    .select('amount_cents, related_run_id, kind')
    .eq('related_run_id', run1)
    .eq('kind', 'debit');
  check(
    'exactly one debit row for the run, signed-negative',
    (debitRows ?? []).length === 1 && debitRows![0].amount_cents === -cents1,
    JSON.stringify(debitRows),
  );

  // ---- 2. re-debit the same run is a no-op (idempotent) ---------------------
  const balBefore = await balance();
  const d2 = await debitRunCredit(athleteId, run1, cents1);
  check('re-debit same run returns false', d2 === false, `repeat for run1`);
  check('balance unchanged after re-debit', (await balance()) === balBefore, `balance=${await balance()}`);

  // ---- 3. overshoot into negative is allowed --------------------------------
  const run2 = await newRun(1.0); // billedCents = 150, balance 420 → -... wait 420
  const cents2 = billedCents(1.0); // 150
  await debitRunCredit(athleteId, run2, cents2);
  const overshot = await balance(); // 420 - 150 = 270 (not negative yet)
  // push it negative with a big one
  const run3 = await newRun(2.5); // 375 cents, 270 → -105
  await debitRunCredit(athleteId, run3, billedCents(2.5));
  check('overshoot lands negative (no clamp)', (await balance()) < 0, `balance=${await balance()}`);

  // ---- balance reconstructs from the ledger ---------------------------------
  check(
    'balance_cents == sum(ledger.amount_cents)',
    (await balance()) === (await ledgerSum()),
    `balance=${await balance()} ledgerSum=${await ledgerSum()}`,
  );

  // ---- 4. comped athlete is never debited -----------------------------------
  await db.from('athlete_credits').update({ comped: true }).eq('athlete_id', athleteId);
  const balComped = await balance();
  const run4 = await newRun(0.9);
  const d4 = await debitRunCredit(athleteId, run4, billedCents(0.9));
  check('comped debit returns false (skipped)', d4 === false, `comped`);
  check('comped balance unchanged', (await balance()) === balComped, `balance=${await balance()}`);

  // ---- gate decision against live data (real getCreditState read) -----------
  // Silence David alerts during the gate check, then exercise enforceCreditGate.
  delete process.env.DAVID_TELEGRAM_CHAT_ID;
  const { enforceCreditGate } = await import('../worker/billing');
  const j = (kind: string) => ({ kind, payload: { athlete_id: athleteId } });

  // comped → allowed even though balance is negative
  check('gate allows comped at negative balance', (await enforceCreditGate(j('daily_checkin'))) === 'allowed', 'comped');

  // un-comp, set $0 → blocked
  await db.from('athlete_credits').update({ comped: false, balance_cents: 0 }).eq('athlete_id', athleteId);
  check('gate blocks non-comped at $0 (daily)', (await enforceCreditGate(j('daily_checkin'))) === 'blocked', 'balance=0');
  check('gate blocks non-comped at $0 (tg_message)', (await enforceCreditGate(j('tg_message'))) === 'blocked', 'adhoc');
  check('gate ignores non-gated kind', (await enforceCreditGate(j('calendar_sync'))) === 'allowed', 'calendar_sync');

  // positive balance → allowed
  await db.from('athlete_credits').update({ balance_cents: 100 }).eq('athlete_id', athleteId);
  check('gate allows non-comped with positive balance', (await enforceCreditGate(j('daily_checkin'))) === 'allowed', 'balance=100');

  // ---- index guard sanity: a second debit row for one run is rejected -------
  // (already proven by step 2's no-op; the unique index is what backs it.)
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
