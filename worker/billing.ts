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

import { billedCents } from '@/server/billing/pricing';
import { debitRunCredit, getCreditState } from '@/server/billing/credits';
import { sendDavidAlert, sendReply } from './send';

// job_queue kinds that cost model money and so are gated at $0. calendar_sync is
// bookkeeping (no agent run) and is never gated. A post_activity run rides inside
// a tg_message job, so gating tg_message covers it too.
const GATED_KINDS = new Set(['daily_checkin', 'tg_message']);

export const BLOCK_REASON_INSUFFICIENT_CREDIT = 'blocked: insufficient_credit';

// The athlete-facing "you're out of credit" message is held behind this flag
// until the top-up infrastructure (/buy, the §8 preset buttons) is in place — a
// friend should only be told they're paused once there's a real way to fix it.
// Off until explicitly enabled. The block itself + the David alert fire
// regardless, so nothing runs at $0 and David always knows.
function gateNoticeEnabled(): boolean {
  const v = (process.env.BILLING_GATE_NOTICE ?? '').toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

// Interim copy used only when the flag is on. References /buy (which exists by
// the time the flag is flipped); the §8 preset buttons come with the warning
// system in a later step. CLAUDE.md voice — short, no AI tells, no guilt.
const OUT_OF_CREDIT_NOTICE =
  "You're out of credit, so I've paused your check-ins. Top up with /buy and I'll pick right back up.";

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
 * Pre-run gate. Returns 'blocked' only for a gated job kind whose non-comped
 * athlete is at <= $0; the caller then marks the job blocked and skips dispatch.
 * On 'blocked' this has already emitted the side notices (David alert always;
 * athlete message behind the flag).
 *
 * Fails OPEN: any error reading the balance, or a missing billing row, allows
 * the run and alerts David. A friend is never denied coaching because the
 * billing cache hiccuped.
 */
export async function enforceCreditGate(job: { kind: string; payload: unknown }): Promise<GateDecision> {
  if (!GATED_KINDS.has(job.kind)) return 'allowed';

  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const athleteId = String(payload.athlete_id ?? '');
  if (!athleteId) return 'allowed'; // dispatch will surface the missing-id error

  let state;
  try {
    state = await getCreditState(athleteId);
  } catch (e) {
    console.error(`[billing] gate read failed for ${athleteId}, allowing run:`, e);
    await sendDavidAlert(
      `Credit gate could not read balance for athlete ${athleteId} — allowing the run (fail-open).`,
    ).catch(() => {});
    return 'allowed';
  }

  if (!state) {
    // No billing row at all — shouldn't happen for an onboarded athlete (the
    // signup grant creates it). Fail open and tell David rather than block.
    await sendDavidAlert(
      `Credit gate found no athlete_credits row for athlete ${athleteId} — allowing the run (fail-open).`,
    ).catch(() => {});
    return 'allowed';
  }

  if (state.comped || state.balanceCents > 0) return 'allowed';

  // Blocked: non-comped, <= $0. Notify and refuse.
  await sendDavidAlert(
    `Athlete ${athleteId} hit $0 — ${job.kind} run blocked. Balance ${state.balanceCents}¢.`,
  ).catch((e) => console.error(`[billing] David alert (gate block) failed for ${athleteId}:`, e));

  if (gateNoticeEnabled()) {
    await sendReply(athleteId, OUT_OF_CREDIT_NOTICE).catch((e) =>
      console.error(`[billing] out-of-credit notice failed for ${athleteId}:`, e),
    );
  }

  return 'blocked';
}
