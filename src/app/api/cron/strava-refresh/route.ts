// Strava keep-alive refresh (2026-07 pause / re-application window).
//
// While every athlete is paused, the daily-checkin cron and the activity webhook
// both hard-skip paused athletes, so the app makes zero Strava calls — it looks
// dead to Strava. This cron keeps the integration live *without* running the
// agent or sending anyone a message: for each real Strava-connected athlete it
// calls fetchRecentActivities (which refreshes+persists the token if expired and
// hits the Strava activities API) and discards the result. That mirrors the
// ephemeral fetch a normal run does — "as if fully operational" — minus the
// agent turn and the outbound message.
//
// By construction this pathway cannot cost an Anthropic call or message an
// athlete: it never enqueues a job, never touches the worker, never calls send.
// Paused state is deliberately ignored here (that's the point) and never changed.
//
// Fire-and-discard, daily, all connected athletes. Delete this route when the
// pause ends and normal runs resume (see PAUSE_RUNBOOK / RESTART_RUNBOOK).

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/db';
import { fetchRecentActivities, StravaTokenBrokenError } from '@/server/strava/activities';

// Match the worker's normal lookback (WORKER_STRAVA_LOOKBACK_DAYS default) so the
// call pattern looks like a real run rather than a distinct footprint.
const LOOKBACK_DAYS = 14;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const db = supabaseAdmin();

    // Every athlete with a Strava connection on file, paused or not.
    const { data: tokens, error: tokErr } = await db
      .from('oauth_tokens')
      .select('athlete_id')
      .eq('provider', 'strava');
    if (tokErr) throw new Error(`oauth_tokens query failed: ${tokErr.message}`);

    const connectedIds = Array.from(new Set((tokens ?? []).map((t) => t.athlete_id as string)));
    if (connectedIds.length === 0) {
      return NextResponse.json({ ok: true, connected: 0, refreshed: 0, broken: 0 });
    }

    // Drop the negative-chat_id test group, same convention as the daily cron and
    // broadcast — they onboard in a Telegram group against prod and aren't real.
    const { data: athletes, error: athErr } = await db
      .from('athletes')
      .select('id, telegram_chat_id')
      .in('id', connectedIds);
    if (athErr) throw new Error(`athletes query failed: ${athErr.message}`);

    const targets = (athletes ?? [])
      .filter((a) => !String(a.telegram_chat_id ?? '').startsWith('-'))
      .map((a) => a.id as string);

    // Sequential: ~dozens of athletes at most, and a burst of parallel pulls is a
    // worse Strava footprint than a steady trickle. One broken token never aborts
    // the batch — count it and move on. Results are discarded (fire-and-discard).
    let refreshed = 0;
    let broken = 0;
    const brokenIds: string[] = [];
    for (const athleteId of targets) {
      try {
        await fetchRecentActivities(athleteId, LOOKBACK_DAYS);
        refreshed++;
      } catch (err) {
        broken++;
        brokenIds.push(athleteId);
        if (!(err instanceof StravaTokenBrokenError)) {
          // A token-broken result is expected drift; anything else is worth eyeing.
          Sentry.captureException(err);
        }
      }
    }

    return NextResponse.json({ ok: true, connected: targets.length, refreshed, broken, brokenIds });
  } catch (err) {
    Sentry.captureException(err);
    console.error('[strava-refresh cron] error', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
