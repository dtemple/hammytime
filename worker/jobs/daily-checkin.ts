import { runAgent } from '../run-agent';

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
  await runAgent(athleteId, 'daily_checkin');
}
