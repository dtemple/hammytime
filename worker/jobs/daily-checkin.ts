import { extendPlanIfDue } from '@/server/plan/extend';
import { runAgent } from '../run-agent';
import { sendDavidAlert } from '../send';

// kind='daily_checkin' job — the morning push is a single message: the
// coaching/training note (the agent run, maps to agent_runs 'daily').
//
// The proactive wellness battery (a second message starting the readiness/
// soreness prompts) was removed — it's now triggered ONLY by the /checkin
// command (src/server/telegram/checkin → handleCheckinCommand). The athlete's
// battery answers still flow through the inbound bot's wellness state machine
// (handleWellnessMessage), which shares checkin_state.
//
// TODO: reintroduce the proactive morning battery later. The deleted
// startWellnessBattery() did: skip if checkin_state.sub_step is already set,
// skip if wellnessLogContains(athleteId, localDate) is true (already logged
// today), else set checkin_state to awaiting_readiness and send READINESS_PROMPT
// via send.ts. wellnessLogContains is kept in checkin/wellness-log.ts for that.
export async function runDailyCheckin(athleteId: string): Promise<void> {
  // GF-W1: keep an open-ended plan rolling. Runs BEFORE the agent's hydrate so
  // the folder picks up the extended plan. A failure must not block the daily
  // message — there are ~2 weeks of plan left to fix it — but it must be loud,
  // or the athlete's calendar quietly empties at the end of the block.
  let extension = null;
  try {
    extension = await extendPlanIfDue(athleteId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[daily-checkin] plan extension failed for ${athleteId}:`, detail);
    await sendDavidAlert(
      `Plan extension failed — plan left unextended.\nAthlete: ${athleteId}\n${detail}`,
    ).catch((e) => console.error(`[daily-checkin] David alert failed for ${athleteId}:`, e));
  }

  await runAgent(athleteId, 'daily_checkin', undefined, undefined, {
    planExtension: extension ?? undefined,
  });
}
