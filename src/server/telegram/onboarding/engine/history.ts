// Onboarding v3 (V3-W2): recent-conversation loader for the engine.
//
// Mirrors worker/system-prompt.ts `loadRecentHistory`/`formatHistory`, kept local
// so the Next.js onboarding path doesn't import across the src→worker boundary.

import { supabaseAdmin } from '@/lib/db';

export type HistoryTurn = { direction: string; body: string };

/** Last N Telegram messages for an athlete, oldest first. */
export async function loadRecentHistory(athleteId: string, limit = 12): Promise<HistoryTurn[]> {
  const { data } = await supabaseAdmin()
    .from('messages')
    .select('direction, body')
    .eq('athlete_id', athleteId)
    .eq('channel', 'tg')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (!data) return [];
  return data.map((m) => ({ direction: m.direction, body: m.body })).reverse();
}
