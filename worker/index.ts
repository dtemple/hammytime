import './env'; // MUST be first — loads .env.local before config.ts reads it

import { POLL_INTERVAL_MS } from './config';
import { BLOCK_REASON_INSUFFICIENT_CREDIT, enforceCreditGate } from './billing';
import { blockJob, claimJob, completeJob, dispatch, failJob } from './poll';

let shuttingDown = false;

async function tick(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;

  console.info(`[worker] claimed job ${job.id} kind=${job.kind} attempt=${job.attempts}`);

  // Pre-run $0 gate (Specs/METERING_PAYMENTS.md §5). A non-comped athlete at
  // <= $0 doesn't run; the job is marked terminally blocked (no retry). The
  // in-flight run that drove them to $0 already completed — this refuses the next.
  if ((await enforceCreditGate(job)) === 'blocked') {
    await blockJob(job.id, BLOCK_REASON_INSUFFICIENT_CREDIT);
    console.info(`[worker] job ${job.id} blocked — insufficient credit`);
    return true;
  }

  try {
    await dispatch(job);
    await completeJob(job.id);
    console.info(`[worker] completed job ${job.id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] job ${job.id} failed:`, message);
    await failJob(job, message);
  }
  return true;
}

async function loop(): Promise<void> {
  console.info(`[worker] poll loop started (interval ${POLL_INTERVAL_MS}ms)`);
  while (!shuttingDown) {
    let didWork = false;
    try {
      didWork = await tick();
    } catch (err) {
      // claimJob itself failed (DB hiccup) — log and back off a poll interval.
      console.error('[worker] poll tick error:', err instanceof Error ? err.message : err);
    }
    // Drain greedily: only sleep when the queue was empty.
    if (!didWork && !shuttingDown) await sleep(POLL_INTERVAL_MS);
  }
  console.info('[worker] poll loop exited');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SIGTERM (Fly stop/deploy) and SIGINT (local Ctrl-C): stop claiming new jobs.
// The current in-flight job finishes because dispatch() is awaited inside tick()
// before the loop re-checks shuttingDown.
function onSignal(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[worker] ${signal} received — draining in-flight job, then exiting`);
}

process.once('SIGTERM', () => onSignal('SIGTERM'));
process.once('SIGINT', () => onSignal('SIGINT'));

loop()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[worker] fatal:', err);
    process.exit(1);
  });
