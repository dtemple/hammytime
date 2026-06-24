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
import {
  grantSignupCredit,
  debitRunCredit,
  getCreditState,
  hasToppedUp,
  recordStripeTopup,
} from '@/server/billing/credits';
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
  let bal = await balance();
  check('grant sets balance to 500¢', bal === 500, `balance=${bal}`);

  // ---- 1. one debit = round(cost×1.5) cents, balance drops ------------------
  const run1 = await newRun(0.53); // billedCents(0.53) = 80
  const cents1 = billedCents(0.53);
  const d1 = await debitRunCredit(athleteId, run1, cents1);
  check('debit returns true', d1 === true, `cents=${cents1}`);
  bal = await balance();
  check('balance drops by the debit', bal === 500 - cents1, `balance=${bal}`);

  const { data: debitRows } = await db
    .from('credit_ledger')
    .select('amount_cents, related_run_id, kind')
    .eq('related_run_id', run1)
    .eq('kind', 'debit');
  const rows = debitRows ?? [];
  check(
    'exactly one debit row for the run, signed-negative',
    rows.length === 1 && rows[0]?.amount_cents === -cents1,
    JSON.stringify(debitRows),
  );

  // ---- 2. re-debit the same run is a no-op (idempotent) ---------------------
  const balBefore = await balance();
  const d2 = await debitRunCredit(athleteId, run1, cents1);
  check('re-debit same run returns false', d2 === false, `repeat for run1`);
  bal = await balance();
  check('balance unchanged after re-debit', bal === balBefore, `balance=${bal}`);

  // ---- 3. overshoot into negative is allowed --------------------------------
  const run2 = await newRun(1.0); // billedCents = 150, balance 420 → 270 (not negative yet)
  await debitRunCredit(athleteId, run2, billedCents(1.0));
  // push it negative with a big one
  const run3 = await newRun(2.5); // 375 cents, 270 → -105
  await debitRunCredit(athleteId, run3, billedCents(2.5));
  bal = await balance();
  check('overshoot lands negative (no clamp)', bal < 0, `balance=${bal}`);

  // ---- balance reconstructs from the ledger ---------------------------------
  const ledger = await ledgerSum();
  check('balance_cents == sum(ledger.amount_cents)', bal === ledger, `balance=${bal} ledgerSum=${ledger}`);

  // ---- 4. comped athlete is never debited -----------------------------------
  await db.from('athlete_credits').update({ comped: true }).eq('athlete_id', athleteId);
  const balComped = await balance();
  const run4 = await newRun(0.9);
  const d4 = await debitRunCredit(athleteId, run4, billedCents(0.9));
  check('comped debit returns false (skipped)', d4 === false, `comped`);
  bal = await balance();
  check('comped balance unchanged', bal === balComped, `balance=${bal}`);

  // ---- gate decision against live data (real getCreditState read) -----------
  // Silence David alerts during the gate checks. The throwaway athlete has no
  // telegram_chat_id, so the blocked-path athlete message throws-and-is-caught —
  // nothing is actually sent.
  delete process.env.DAVID_TELEGRAM_CHAT_ID;
  const { enforceCreditGate } = await import('../worker/billing');
  const j = (kind: string) => ({ kind, payload: { athlete_id: athleteId } });

  // Gate OFF (default): the whole feature is dark — a $0 non-comped athlete still
  // runs; only the draw-down (above) meters them.
  delete process.env.BILLING_GATE_ENABLED;
  await db.from('athlete_credits').update({ comped: false, balance_cents: 0 }).eq('athlete_id', athleteId);
  check('gate OFF: non-comped at $0 still allowed', (await enforceCreditGate(j('daily_checkin'))) === 'allowed', 'flag unset');

  // Gate ON: enforcement active.
  process.env.BILLING_GATE_ENABLED = 'true';
  check('gate ON: blocks non-comped at $0 (daily)', (await enforceCreditGate(j('daily_checkin'))) === 'blocked', 'balance=0');
  check('gate ON: blocks non-comped at $0 (tg_message)', (await enforceCreditGate(j('tg_message'))) === 'blocked', 'adhoc');
  check('gate ON: ignores non-gated kind', (await enforceCreditGate(j('calendar_sync'))) === 'allowed', 'calendar_sync');

  // comped → allowed even at $0
  await db.from('athlete_credits').update({ comped: true }).eq('athlete_id', athleteId);
  check('gate ON: allows comped at $0', (await enforceCreditGate(j('daily_checkin'))) === 'allowed', 'comped');

  // positive balance → allowed
  await db.from('athlete_credits').update({ comped: false, balance_cents: 100 }).eq('athlete_id', athleteId);
  check('gate ON: allows non-comped with positive balance', (await enforceCreditGate(j('daily_checkin'))) === 'allowed', 'balance=100');

  // ---- 5. low-balance heads-up (§8) -----------------------------------------
  // Runway = balance_cents / 80 for this athlete (no rollup row → the default
  // 80¢/day burn). ≤2 days (≤160¢) fires; >2 days doesn't. The throwaway athlete
  // has no telegram_chat_id, so the send throws-and-is-caught inside the helper
  // and the dedupe column still lands — we assert against that column.
  const { maybeWarnLowBalance } = await import('../worker/billing');
  const setCredits = (over: Record<string, unknown>) =>
    db.from('athlete_credits').update(over).eq('athlete_id', athleteId);
  const warnedAt = async (): Promise<string | null> => {
    const { data } = await db
      .from('athlete_credits')
      .select('low_balance_warned_at')
      .eq('athlete_id', athleteId)
      .maybeSingle();
    return (data?.low_balance_warned_at as string | null) ?? null;
  };

  // gate must be on for the heads-up to fire (set above; make it explicit).
  process.env.BILLING_GATE_ENABLED = 'true';

  // above threshold → doesn't fire
  await setCredits({ comped: false, balance_cents: 400, low_balance_warned_at: null });
  await maybeWarnLowBalance(athleteId);
  check('heads-up: above threshold (5 days) does not fire', (await warnedAt()) === null, 'balance=400');

  // first-time low → fires; never topped up yet, so the explainer path
  check('heads-up: not topped up yet', (await hasToppedUp(athleteId)) === false, 'pre-topup');
  await setCredits({ balance_cents: 120 });
  await maybeWarnLowBalance(athleteId);
  const firstWarn = await warnedAt();
  check('heads-up: fires at ~1.5 days (column set)', firstWarn !== null, `warnedAt=${firstWarn}`);

  // dedupe → a second call doesn't re-mark
  await maybeWarnLowBalance(athleteId);
  check('heads-up: dedupes (timestamp unchanged)', (await warnedAt()) === firstWarn, 'second call no-op');

  // a top-up clears the dedupe column AND flips the selector to the short version
  await recordStripeTopup(athleteId, 'pi_verify_drawdown_topup', 1000);
  check('heads-up: top-up cleared the dedupe column', (await warnedAt()) === null, 'rearmed');
  check('heads-up: topped up now true', (await hasToppedUp(athleteId)) === true, 'post-topup');

  // re-arm → next low cycle fires again (now the short-version path)
  await setCredits({ balance_cents: 120, low_balance_warned_at: null });
  await maybeWarnLowBalance(athleteId);
  check('heads-up: re-arms and fires again after top-up', (await warnedAt()) !== null, 'second cycle');

  // $0 → the gate owns it, heads-up bails
  await setCredits({ balance_cents: 0, low_balance_warned_at: null });
  await maybeWarnLowBalance(athleteId);
  check('heads-up: skips at $0 (gate owns it)', (await warnedAt()) === null, 'balance=0');

  // comped → never warned
  await setCredits({ comped: true, balance_cents: 120, low_balance_warned_at: null });
  await maybeWarnLowBalance(athleteId);
  check('heads-up: skips a comped athlete', (await warnedAt()) === null, 'comped');

  // gate off → dark
  delete process.env.BILLING_GATE_ENABLED;
  await setCredits({ comped: false, balance_cents: 120, low_balance_warned_at: null });
  await maybeWarnLowBalance(athleteId);
  check('heads-up: gate OFF stays dark', (await warnedAt()) === null, 'flag unset');

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
