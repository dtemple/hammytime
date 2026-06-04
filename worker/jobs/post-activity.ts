import { runAgent } from '../run-agent';

// kind='tg_message' job flagged `trigger: 'post_activity'` — a proactive run
// fired when the athlete's just-finished workout landed on Strava. Routed here
// (not to runTgMessage) so the agent gets the post-activity prompt instead of
// the generic seed. Maps to agent_runs kind 'adhoc' inside runAgent.
//
// `activityId` is the triggering Strava activity id, passed through so the
// prompt can point the agent at the right entry (it's also the newest one in
// the freshly re-fetched strava_recent.json).
export async function runPostActivity(athleteId: string, activityId?: number): Promise<void> {
  await runAgent(athleteId, 'post_activity', undefined, activityId);
}
