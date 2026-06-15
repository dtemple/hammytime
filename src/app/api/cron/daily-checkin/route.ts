import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/db';
import { nowInTimezone } from '@/server/telegram/checkin/dispatcher';
import { enqueueJob } from '@/server/jobs/enqueue';
import { isOnboarded } from '@/server/telegram/onboarding';
import {
  INACTIVITY_WINDOW_DAYS,
  isInactive,
  sendAutoPauseNotice,
} from '@/server/telegram/pause';

function dryRunRequested(req: Request): boolean {
  const param = new URL(req.url).searchParams.get('dryRun')?.toLowerCase() ?? '';
  const env = (process.env.AUTO_PAUSE_DRY_RUN ?? '').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(param) || ['1', 'true', 'yes', 'on'].includes(env);
}

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
    const dryRun = dryRunRequested(req);

    const { data: athletes, error } = await supabaseAdmin()
      .from('athletes')
      .select('*')
      .not('telegram_chat_id', 'is', null);
    if (error) throw new Error(`athletes query failed: ${error.message}`);

    const onboarded = (athletes ?? []).filter((a) => {
      // Test athletes onboard inside a Telegram group (negative chat_id) against
      // prod. Never enqueue daily coaching for them: the worker sends as the real
      // bot (which isn't in the group), so the job would fail, retry, and alert —
      // and with the staging bot off between sessions there's no one to receive it.
      // See docs/testing-onboarding.md.
      if (String(a.telegram_chat_id).startsWith('-')) return false;
      // Paused athletes (auto-inactivity or manual /pause) draw no daily run.
      // This is also what makes the auto-pause notice fire exactly once: once
      // paused_at is set, every later pass skips the athlete here, so they're
      // never re-evaluated and never re-notified (§10.5).
      if (a.paused_at != null) return false;
      // Both onboarding flows. v3 stores { flow:'v3', phase } with no `step`, so
      // the old step-only check silently dropped every v3-onboarded athlete from
      // daily coaching (the same predicate bot.ts uses for inbound commands).
      return isOnboarded(
        a.onboarding_state as { flow?: string; phase?: string; step?: number } | null,
      );
    });

    if (onboarded.length === 0) {
      return NextResponse.json({ ok: true, skipped: 'no_onboarded_athlete' });
    }

    // Inactivity scan (§10.5): one bounded query for the athletes with any
    // inbound message inside the window. An onboarded athlete who isn't in this
    // set and was created before the window opened has gone silent — auto-pause
    // them instead of enqueuing. Bounding on sent_at keeps this off the full
    // message history.
    const cutoffMs = Date.now() - INACTIVITY_WINDOW_DAYS * 86_400_000;
    const { data: recent, error: recentErr } = await supabaseAdmin()
      .from('messages')
      .select('athlete_id')
      .eq('direction', 'in')
      .gte('sent_at', new Date(cutoffMs).toISOString());
    if (recentErr) throw new Error(`recent-inbound query failed: ${recentErr.message}`);
    const activeIds = new Set((recent ?? []).map((m) => m.athlete_id));

    // Enqueue one daily coaching job per active athlete; the worker drains them
    // and runs the agent. The per-day unique key (in the athlete's local
    // timezone) makes a cron overlap a no-op. enqueueJob throws on a DB error,
    // so a per-athlete failure aborts the batch — the next cron tick retries the
    // not-yet-enqueued athletes (their keys are still free).
    let enqueued = 0;
    const paused: string[] = [];
    for (const athlete of onboarded) {
      // TODO(§5 gate): once the $0 balance gate ships, skip the inactivity scan
      // for athletes already blocked at $0 — they've stopped running and got the
      // §8 final message; a second "paused" note would just be noise.
      if (isInactive(athlete, activeIds, cutoffMs)) {
        paused.push(athlete.id);
        // Dry run: report the candidate, write nothing, send nothing. Lets David
        // eyeball the set against real friends before flipping it live.
        if (dryRun) continue;
        await supabaseAdmin()
          .from('athletes')
          .update({ paused_at: new Date().toISOString(), pause_reason: 'auto_inactivity' })
          .eq('id', athlete.id);
        try {
          await sendAutoPauseNotice(athlete);
        } catch (sendErr) {
          // A missed notice is recoverable (the friend resumes by messaging), so
          // never let one bad send abort the batch the way enqueueJob would.
          Sentry.captureException(sendErr);
          console.error('[daily-checkin cron] auto-pause notice failed', athlete.id, sendErr);
        }
        continue;
      }

      const { date } = nowInTimezone(athlete.timezone);
      await enqueueJob('daily_checkin', `daily-${athlete.id}-${date}`, { athlete_id: athlete.id });
      enqueued++;
    }

    return NextResponse.json({ ok: true, enqueued, paused, dryRun });
  } catch (err) {
    Sentry.captureException(err);
    console.error('[daily-checkin cron] error', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
