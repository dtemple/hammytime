import { runAgent } from '../run-agent';

// kind='daily_checkin' job — the morning coaching read. Maps to agent_runs
// kind 'daily' inside runAgent.
export async function runDailyCheckin(athleteId: string): Promise<void> {
  await runAgent(athleteId, 'daily_checkin');
}
