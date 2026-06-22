// Sweeps expired plan proposals (Specs/CALENDAR_CONFIRM.md). A proposal whose
// expiry has passed without a tap lingers as a `proposed` plan_versions row with
// a live button. This daily pass discards the row and resolves the stale button
// so it can't be tapped and stops sitting as the athlete's newest version.
//
// Runs Vercel-side from the daily-checkin cron, so it edits the stale message
// through the bot's own api rather than the worker's send helpers.

import { supabaseAdmin } from '@/lib/db';
import { telegramBot } from './bot';

const EXPIRED_NOTE = 'Update your calendar?\n\nThis proposal expired — your plan stays as it was.';

// Discards every proposal past its expiry and resolves its button. Idempotent:
// the RPC is token-matched, so a row already cleared resolves to 'not_found' and
// is skipped. Returns the count actually discarded.
export async function sweepExpiredProposals(now: Date = new Date()): Promise<number> {
  const db = supabaseAdmin();
  const { data: plans, error } = await db
    .from('plans')
    .select('id, athlete_id, proposed_token, proposed_message_id')
    .not('proposed_version_id', 'is', null)
    .lt('proposed_expires_at', now.toISOString());
  if (error) throw new Error(`sweepExpiredProposals query failed: ${error.message}`);

  let discarded = 0;
  for (const plan of plans ?? []) {
    if (!plan.proposed_token) continue;
    const { data: result, error: rpcErr } = await db.rpc('discard_proposed_version', {
      p_plan_id: plan.id,
      p_token: plan.proposed_token,
    });
    if (rpcErr) {
      console.error(`[proposals] discard failed for plan ${plan.id}: ${rpcErr.message}`);
      continue;
    }
    if (result !== 'discarded') continue;
    discarded++;
    if (plan.proposed_message_id != null) {
      await resolveExpiredButton(plan.athlete_id, plan.proposed_message_id).catch((e) =>
        console.error(`[proposals] resolve stale button failed for ${plan.athlete_id}:`, e),
      );
    }
  }
  return discarded;
}

async function resolveExpiredButton(athleteId: string, messageId: number): Promise<void> {
  const { data: athlete } = await supabaseAdmin()
    .from('athletes')
    .select('telegram_chat_id')
    .eq('id', athleteId)
    .maybeSingle();
  if (!athlete?.telegram_chat_id) return;
  await telegramBot().api.editMessageText(athlete.telegram_chat_id, messageId, EXPIRED_NOTE);
}
