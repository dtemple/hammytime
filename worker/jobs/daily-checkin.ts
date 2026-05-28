import { supabaseAdmin } from '@/lib/db';
import { READINESS_PROMPT } from '@/server/telegram/checkin/wellness';
import { wellnessLogContains } from '@/server/telegram/checkin/wellness-log';
import { runAgent } from '../run-agent';
import { sendReply } from '../send';

// kind='daily_checkin' job — the morning push is two messages, in order:
//   1. the coaching/training note (the agent run, maps to agent_runs 'daily')
//   2. the wellness battery (readiness, then soreness), started right after
// The athlete's battery answers flow back through the inbound bot's wellness
// state machine (src/server/telegram/checkin), which shares checkin_state.
export async function runDailyCheckin(athleteId: string): Promise<void> {
  await runAgent(athleteId, 'daily_checkin');
  await startWellnessBattery(athleteId);
}

async function startWellnessBattery(athleteId: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: athlete } = await db
    .from('athletes')
    .select('checkin_state, timezone')
    .eq('id', athleteId)
    .maybeSingle();
  if (!athlete) return;

  // Don't clobber an in-progress battery, and don't re-prompt if the athlete
  // already logged wellness today (e.g. ran /checkin manually before the job).
  const cs = athlete.checkin_state as { sub_step?: string } | null;
  if (cs?.sub_step) return;
  if (await wellnessLogContains(athleteId, localDate(athlete.timezone))) return;

  await db
    .from('athletes')
    .update({
      checkin_state: { sub_step: 'awaiting_readiness', partial: {} },
      updated_at: new Date().toISOString(),
    })
    .eq('id', athleteId);
  await sendReply(athleteId, READINESS_PROMPT);
}

function localDate(tz: string | null): string {
  const timeZone = tz ?? 'America/Los_Angeles';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
}
