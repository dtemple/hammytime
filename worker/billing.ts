// Worker-side metering orchestration (Specs/METERING_PAYMENTS.md §5).
//
// Two halves:
//   chargeRun()        — post-run draw-down. Called from run-agent once a run's
//                        agent_runs row is persisted; debits cost_usd × markup.
//   enforceCreditGate() — pre-run gate at dequeue. Refuses the NEXT run for a
//                        non-comped athlete at <= $0. The in-flight run that
//                        drove them there already completed.
//
// The markup + rounding live in src/server/billing/pricing.ts (one source of
// truth, shared with the web). The atomic debit + balance read live in
// src/server/billing/credits.ts. This module wires them to the worker's queue
// and Telegram surface.

import { billedCents, dollarsLabel } from '@/server/billing/pricing';
import {
  debitRunCredit,
  getCreditState,
  getLowBalanceWarnState,
  hasToppedUp,
  markLowBalanceWarned,
} from '@/server/billing/credits';
import { estimateRunwayDays, runwayLabel } from '@/server/billing/burn-rate';
import { sendDavidAlert, sendReply, sendTopupButtons } from './send';

// job_queue kinds that cost model money and so are gated at $0. calendar_sync is
// bookkeeping (no agent run) and is never gated. A post_activity run rides inside
// a tg_message job, so gating tg_message covers it too.
const GATED_KINDS = new Set(['daily_checkin', 'tg_message']);

export const BLOCK_REASON_INSUFFICIENT_CREDIT = 'blocked: insufficient_credit';

// The whole $0 enforcement — the block AND the athlete-facing notice — is held
// behind this flag until the top-up path (/buy, the §8 preset buttons) exists.
// While it's off, a non-comped athlete at <= $0 still RUNS: the post-run
// draw-down keeps metering them (the balance can go negative), but nothing is
// refused, no one is messaged, and David isn't alerted. Flip it on once a
// blocked friend has a real way to pay. Off unless explicitly enabled.
function gateEnabled(): boolean {
  const v = (process.env.BILLING_GATE_ENABLED ?? '').toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

// The §8 final notice, sent (with the preset buttons) when the gate blocks a run
// at $0. CLAUDE.md voice — short, no AI tells, no guilt.
const OUT_OF_CREDIT_NOTICE =
  "That's the last of your credit, so I've paused. Top up below to pick back up where we left off.";

// Runway, in days, at or below which the §8 heads-up fires. Lowered from the
// spec's ~7 to ~2 because the $5 signup grant is only ~6 days at the §2 burn —
// a 7-day trigger would fire on day one for every new athlete. 2 days clears the
// grant and a fresh top-up while still leaving ~2 check-ins of lead time.
const HEADS_UP_RUNWAY_DAYS = 2;

// The recurring heads-up — sent once an athlete has topped up before, so they
// already know how credits work.
function shortHeadsUp(balanceCents: number, days: number): string {
  return `Quick heads-up: about ${dollarsLabel(balanceCents)} of credit left, ${runwayLabel(
    days,
  )} at your pace. Top up anytime with /buy.`;
}

// The first-ever heads-up — the athlete's first contact with the credits idea
// (onboarding never mentions it, and the whole system is dark until the gate
// flips), so this one introduces it before stating the balance.
function explainerHeadsUp(balanceCents: number, days: number): string {
  return (
    'Hi. Quick note on how Daybreak keeps the lights on: it runs on a credits system, and ' +
    'credits only cover what Daybreak costs to run — nothing more. Most of that is AI token ' +
    'costs; a small slice is Stripe fees and hosting.\n\n' +
    `You have ${dollarsLabel(balanceCents)} of credit left, ${runwayLabel(
      days,
    )} at your pace. Top up anytime with /buy.`
  );
}

/**
 * Post-run draw-down. Best-effort: a debit failure logs but never blocks
 * delivery (the ledger reconciles, mirroring persistRun). No-op when the run
 * was free or unpriced, or when the athlete is comped (the RPC short-circuits).
 */
export async function chargeRun(
  athleteId: string,
  runId: string,
  costUsd: number | null | undefined,
): Promise<void> {
  const cents = billedCents(costUsd ?? 0);
  if (cents <= 0) return; // free/unpriced run — nothing to debit, no noise row
  try {
    const debited = await debitRunCredit(athleteId, runId, cents);
    if (!debited) {
      console.info(`[billing] run ${runId}: debit skipped (comped or already debited)`);
    }
  } catch (e) {
    console.error(`[billing] debit failed for run ${runId} (athlete ${athleteId}):`, e);
  }
}

export type GateDecision = 'allowed' | 'blocked';

/**
 * Pre-run gate. Disabled entirely unless BILLING_GATE_ENABLED is set (see
 * gateEnabled) — while off, always returns 'allowed', so a $0 athlete still runs
 * and only the silent draw-down meters them. When on, returns 'blocked' for a
 * gated job kind whose non-comped athlete is at <= $0; the caller then marks the
 * job blocked and skips dispatch. On 'blocked' this has already alerted David and
 * messaged the athlete.
 *
 * Fails OPEN: any error reading the balance, or a missing billing row, allows
 * the run and alerts David. A friend is never denied coaching because the
 * billing cache hiccuped.
 */
export async function enforceCreditGate(job: { kind: string; payload: unknown }): Promise<GateDecision> {
  if (!gateEnabled()) return 'allowed'; // enforcement off — meter silently, never block
  if (!GATED_KINDS.has(job.kind)) return 'allowed';

  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const athleteId = String(payload.athlete_id ?? '');
  if (!athleteId) return 'allowed'; // dispatch will surface the missing-id error

  // Fail open: a billing-read problem must never deny coaching. Alert David, allow.
  const failOpen = async (why: string): Promise<GateDecision> => {
    console.error(`[billing] gate failing open for ${athleteId}: ${why}`);
    await sendDavidAlert(
      `Credit gate ${why} for athlete ${athleteId} — allowing the run (fail-open).`,
    ).catch(() => {});
    return 'allowed';
  };

  let state;
  try {
    state = await getCreditState(athleteId);
  } catch (e) {
    return failOpen(`could not read balance (${e instanceof Error ? e.message : String(e)})`);
  }
  // No billing row shouldn't happen for an onboarded athlete (the signup grant
  // creates it) — fail open rather than block.
  if (!state) return failOpen('found no athlete_credits row');

  if (state.comped || state.balanceCents > 0) return 'allowed';

  // Blocked: non-comped, <= $0. Notify and refuse.
  await sendDavidAlert(
    `Athlete ${athleteId} hit $0 — ${job.kind} run blocked. Balance ${state.balanceCents}¢.`,
  ).catch((e) => console.error(`[billing] David alert (gate block) failed for ${athleteId}:`, e));

  await sendTopupButtons(athleteId, OUT_OF_CREDIT_NOTICE).catch((e) =>
    console.error(`[billing] out-of-credit notice failed for ${athleteId}:`, e),
  );

  return 'blocked';
}

/**
 * Post-run low-balance heads-up (Specs/METERING_PAYMENTS.md §8). Called from
 * run-agent after the draw-down lands and the coach's reply is sent, so the
 * nudge follows the coaching and reflects this run's debit. One gentle message
 * when runway drops to ~2 days while the balance is still positive; the gate
 * (not this) owns the $0 case.
 *
 * Held behind the same BILLING_GATE_ENABLED flag as the gate — during the free
 * era a $0 balance has no consequence, so no one is told they're "running low."
 *
 * Deduped by athlete_credits.low_balance_warned_at (set here, cleared on any
 * top-up by apply_stripe_credit, so the next low cycle re-warns). Best-effort
 * throughout — a send or write failure logs and never blocks delivery. The
 * mark follows the send attempt: a rare failed send still dedupes (the gate's
 * $0 notice is the real backstop), which also lets the throwaway-athlete
 * verification exercise this end to end.
 */
export async function maybeWarnLowBalance(athleteId: string): Promise<void> {
  if (!gateEnabled()) return; // dark in the free era, like the gate itself

  let state;
  try {
    state = await getLowBalanceWarnState(athleteId);
  } catch (e) {
    console.error(`[billing] low-balance read failed for ${athleteId}:`, e);
    return;
  }
  if (!state) return; // no billing row — nothing to warn against
  if (state.comped) return; // on the house — never warned
  if (state.balanceCents <= 0) return; // the gate owns $0
  if (state.warnedAt) return; // already warned this cycle (a top-up re-arms it)

  const days = await estimateRunwayDays(state.balanceCents, athleteId);
  if (days > HEADS_UP_RUNWAY_DAYS) return; // still plenty of runway

  // First contact with credits gets the explainer; once they've topped up, the
  // short nudge. A read hiccup on the history defaults to the explainer — more
  // context is the safer miss for a first money message.
  let toppedUp = false;
  try {
    toppedUp = await hasToppedUp(athleteId);
  } catch (e) {
    console.error(`[billing] top-up history read failed for ${athleteId}:`, e);
  }
  const text = toppedUp
    ? shortHeadsUp(state.balanceCents, days)
    : explainerHeadsUp(state.balanceCents, days);

  // Plain text — the heads-up nudges toward /buy without buttons; the preset
  // buttons are reserved for the $0 final notice, where the friction matters.
  await sendReply(athleteId, text).catch((e) =>
    console.error(`[billing] low-balance heads-up send failed for ${athleteId}:`, e),
  );
  await markLowBalanceWarned(athleteId).catch((e) =>
    console.error(`[billing] mark low-balance-warned failed for ${athleteId}:`, e),
  );
}
