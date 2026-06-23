import { runAgent } from '../run-agent';

// kind='tg_message' job — an ad-hoc athlete message. Maps to agent_runs kind
// 'adhoc' inside runAgent.
export async function runTgMessage(
  athleteId: string,
  text: string,
  attempt?: number,
): Promise<void> {
  await runAgent(athleteId, 'tg_message', text, undefined, { attempt });
}
