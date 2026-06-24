// One-off verification for METERING_PAYMENTS §11 manual adjust + comped toggle
// (step 7, admin console). Same self-cleaning shape as verify-drawdown.ts:
// creates a THROWAWAY athlete, exercises adjust_credit + setComped against real
// rows, then deletes the athlete — the FK cascade wipes its athlete_credits +
// credit_ledger rows, leaving prod exactly as found. No model spend, no Telegram.
//
//   npx tsx scripts/verify-adjust.ts

import { config } from 'dotenv';
config({ path: '.env.local' });

import { supabaseAdmin } from '@/lib/db';
import {
  grantSignupCredit,
  adjustCredit,
  setComped,
  getCreditState,
} from '@/server/billing/credits';

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

async function comped(): Promise<boolean> {
  const s = await getCreditState(athleteId);
  return s?.comped ?? false;
}

async function latestAdjust() {
  const { data } = await db
    .from('credit_ledger')
    .select('kind, amount_cents, balance_after_cents, note')
    .eq('athlete_id', athleteId)
    .eq('kind', 'adjust')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function main() {
  const { data: a, error } = await db
    .from('athletes')
    .insert({ name: 'verify-adjust (throwaway)' })
    .select('id')
    .single();
  if (error || !a) throw new Error(`athlete insert failed: ${error?.message}`);
  athleteId = a.id;
  console.log(`throwaway athlete ${athleteId}\n`);

  await grantSignupCredit(athleteId);
  let bal = await balance();
  check('grant sets balance to 500¢', bal === 500, `balance=${bal}`);

  // ---- 1. positive adjust: +250¢ credit, signed ledger row + balance bump ----
  const newBal1 = await adjustCredit(athleteId, 250, 'comp: make-good');
  check('positive adjust returns new balance 750', newBal1 === 750, `returned=${newBal1}`);
  bal = await balance();
  check('balance bumped to 750', bal === 750, `balance=${bal}`);
  let row = await latestAdjust();
  check(
    'positive adjust row: signed +250, note, balance_after',
    !!row &&
      row.amount_cents === 250 &&
      row.note === 'comp: make-good' &&
      row.balance_after_cents === 750,
    JSON.stringify(row),
  );

  // ---- 2. negative adjust: −300¢ debit -------------------------------------
  const newBal2 = await adjustCredit(athleteId, -300, 'correction: double credit');
  check('negative adjust returns new balance 450', newBal2 === 450, `returned=${newBal2}`);
  bal = await balance();
  check('balance dropped to 450', bal === 450, `balance=${bal}`);
  row = await latestAdjust();
  check(
    'negative adjust row: signed −300, note, balance_after',
    !!row &&
      row.amount_cents === -300 &&
      row.note === 'correction: double credit' &&
      row.balance_after_cents === 450,
    JSON.stringify(row),
  );

  // ---- 3. adjust is NOT idempotent — two identical adjusts both apply --------
  await adjustCredit(athleteId, 100, 'tip');
  await adjustCredit(athleteId, 100, 'tip');
  bal = await balance();
  check('two identical +100 adjusts both apply (650)', bal === 650, `balance=${bal}`);
  const { data: adjRows } = await db
    .from('credit_ledger')
    .select('id')
    .eq('athlete_id', athleteId)
    .eq('kind', 'adjust');
  check(
    'four adjust rows total (no dedupe)',
    (adjRows ?? []).length === 4,
    `count=${(adjRows ?? []).length}`,
  );

  // ---- 4. required note + non-zero amount enforced in the RPC ----------------
  let threwOnEmptyNote = false;
  try {
    await adjustCredit(athleteId, 100, '   ');
  } catch {
    threwOnEmptyNote = true;
  }
  check('blank note is rejected', threwOnEmptyNote, 'whitespace note');

  let threwOnZero = false;
  try {
    await adjustCredit(athleteId, 0, 'noop');
  } catch {
    threwOnZero = true;
  }
  check('zero amount is rejected', threwOnZero, 'amount=0');

  const balBeforeFails = await balance();
  check(
    'rejected adjusts did not move the balance',
    balBeforeFails === 650,
    `balance=${balBeforeFails}`,
  );

  // ---- 5. comped toggle persists -------------------------------------------
  await setComped(athleteId, true);
  check('comped flips to true', (await comped()) === true, 'set true');
  await setComped(athleteId, false);
  check('comped flips back to false', (await comped()) === false, 'set false');

  // ---- 6. adjust applies even when comped (explicit override) ---------------
  await setComped(athleteId, true);
  const newBal6 = await adjustCredit(athleteId, 500, 'seed before un-comping');
  check('adjust applies to a comped athlete', newBal6 === 1150, `returned=${newBal6}`);
  bal = await balance();
  check('comped balance bumped to 1150', bal === 1150, `balance=${bal}`);
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
