// Job-queue claim + dispatch (M1 plan §3.2). One job at a time for M1.

import { supabaseAdmin } from '@/lib/db';
import type { Database } from '@/lib/db-types';
import { MAX_ATTEMPTS, STALE_LOCK_MINUTES } from './config';
import { sendDavidAlert } from '@/server/admin/alerts';
import { runDailyCheckin } from './jobs/daily-checkin';
import { runTgMessage } from './jobs/tg-message';

export type Job = Database['public']['Tables']['job_queue']['Row'];

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;

export async function claimJob(): Promise<Job | null> {
  const { data, error } = await supabaseAdmin().rpc('claim_next_job', {
    p_stale_minutes: STALE_LOCK_MINUTES,
  });
  if (error) throw new Error(`claimJob: ${error.message}`);
  // The function returns NULL (all-null composite) when nothing is due.
  if (!data || (data as Job).id == null) return null;
  return data as Job;
}

export async function dispatch(job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const athleteId = String(payload.athlete_id ?? '');
  if (!athleteId) throw new Error(`dispatch: job ${job.id} has no athlete_id in payload`);

  switch (job.kind) {
    case 'daily_checkin':
      await runDailyCheckin(athleteId);
      return;
    case 'tg_message':
      await runTgMessage(athleteId, String(payload.text ?? ''));
      return;
    default:
      throw new Error(`dispatch: unknown job kind ${job.kind}`);
  }
}

export async function completeJob(jobId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('job_queue')
    .update({ completed_at: new Date().toISOString(), locked_at: null, last_error: null })
    .eq('id', jobId);
  if (error) console.error(`[poll] completeJob ${jobId} failed:`, error.message);
}

export async function failJob(job: Job, message: string): Promise<void> {
  const db = supabaseAdmin();
  if (job.attempts >= MAX_ATTEMPTS) {
    // Terminal: leave completed_at null, mark the error, stop retrying, alert.
    await db
      .from('job_queue')
      .update({ locked_at: new Date().toISOString(), last_error: `DEAD after ${job.attempts}: ${message}` })
      .eq('id', job.id);
    await sendDavidAlert(`Job ${job.id} (${job.kind}) dead after ${job.attempts} attempts: ${message}`).catch(
      () => {},
    );
    return;
  }
  const runAfter = new Date(Date.now() + backoffMs(job.attempts)).toISOString();
  const { error } = await db
    .from('job_queue')
    .update({ locked_at: null, last_error: message, run_after: runAfter })
    .eq('id', job.id);
  if (error) console.error(`[poll] failJob ${job.id} update failed:`, error.message);
}

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}
