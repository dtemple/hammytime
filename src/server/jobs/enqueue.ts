// Enqueues a job for the Fly.io worker to drain (SPEC §3.1, M1 plan §7/§10).
// The Vercel side only inserts rows; it never runs the agent.
//
// key_unique carries the idempotency: a cron overlap or a Telegram retry that
// re-enqueues the same key is a no-op, which is exactly the dedup the old
// inline guards (wellnessLogContains, mid-checkin) used to provide.

import { supabaseAdmin } from '@/lib/db';
import type { Json } from '@/lib/db-types';

export type JobKind = 'daily_checkin' | 'tg_message';

export async function enqueueJob(
  kind: JobKind,
  keyUnique: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('job_queue')
    .upsert(
      { kind, key_unique: keyUnique, payload: payload as Json },
      { onConflict: 'key_unique', ignoreDuplicates: true },
    );
  if (error) throw new Error(`enqueueJob(${kind}) failed: ${error.message}`);
}
