import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/db';
import { nowInTimezone } from '@/server/telegram/checkin/dispatcher';
import { enqueueJob } from '@/server/jobs/enqueue';
import { isOnboarded } from '@/server/telegram/onboarding';
import {
  INACTIVITY_WINDOW_DAYS,
  enterDormant,
  isEventCompleteForAthlete,
  isInactive,
  sendAutoPauseNotice,
  sendPostEventPauseNotice,
  sweepCheckBacks,
} from '@/server/telegram/pause';
import { sweepExpiredProposals } from '@/server/telegram/proposals';

// The hour, in each athlete's own timezone, at which their daily run fires. The
// cron ticks hourly; an athlete is due only on the tick where it's this hour
// where they live, so everyone gets it early local rather than 6:30 Pacific for
// all. Set to 5 (not 6): Vercel only guarantees a cron fires within its hour, so
// "5am local" lands somewhere in the 5 o'clock hour — comfortably before 6.
const CHECKIN_HOUR = 5;

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

    // Hygiene: clear any proposal past its expiry and pull its stale button.
    // Independent of the inactivity scan below — a dead proposal is dead whether
    // or not we're dry-running auto-pause.
    const expiredProposalsCleared = await sweepExpiredProposals().catch((e) => {
      Sentry.captureException(e);
      console.error('[daily-checkin cron] proposal sweep failed', e);
      return 0;
    });

    // One-shot off-ramp check-back nudges (v4 / V4-W2): fire any that have come due
    // and null them. Independent of the inactivity scan and timezone-gating below —
    // a months-out nudge fires on the first hourly tick past its date.
    const checkBacksNudged = await sweepCheckBacks().catch((e) => {
      Sentry.captureException(e);
      console.error('[daily-checkin cron] check-back sweep failed', e);
      return 0;
    });

    // Fields every response carries; each return spreads this and adds its own.
    const base = { ok: true as const, expiredProposalsCleared, checkBacksNudged };

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
      return NextResponse.json({ ...base, skipped: 'no_onboarded_athlete' });
    }

    // Per-athlete-local scheduling: the cron fires hourly, but an athlete is due
    // only on the tick where it's CHECKIN_HOUR in their own timezone. Gating both
    // the enqueue and the inactivity scan on this means each athlete is evaluated
    // exactly once per local day, at their local morning — and 23 of every 24
    // ticks bail out here before touching the messages table.
    // Stamp each athlete's local clock once and carry it: the gate reads `hour`,
    // the enqueue key below reads `date` — both from the same instant.
    const due = onboarded
      .map((athlete) => ({ athlete, ...nowInTimezone(athlete.timezone) }))
      .filter(({ hour }) => hour === CHECKIN_HOUR);

    if (due.length === 0) {
      return NextResponse.json({ ...base, skipped: 'no_athlete_due_this_hour' });
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
    const postEventPaused: string[] = [];
    for (const { athlete, date } of due) {
      // Post-event pause (v4 / V4-W3): a committed athlete whose event is behind
      // them and whose plan's dated days are spent (after one grounded race-day+1
      // run) goes dormant — no maintenance plan, daily check-ins stop, Q&A stays
      // open. Checked before the inactivity scan so the reason is 'dormant' (an
      // inbound won't wake them), not 'auto_inactivity'. `date` is the athlete's
      // local calendar day, the same value the enqueue key below uses.
      if (await isEventCompleteForAthlete(athlete.id, date)) {
        postEventPaused.push(athlete.id);
        // Dry run: report the candidate, write nothing, send nothing — same as the
        // inactivity branch, so David can eyeball the set before it goes live.
        if (dryRun) continue;
        await enterDormant(athlete.id, null); // passive pause — no check-back nudge
        try {
          await sendPostEventPauseNotice(athlete);
        } catch (sendErr) {
          // A missed notice is recoverable (Q&A still works); never let one bad
          // send abort the batch the way enqueueJob would.
          Sentry.captureException(sendErr);
          console.error('[daily-checkin cron] post-event pause notice failed', athlete.id, sendErr);
        }
        continue;
      }

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

      await enqueueJob('daily_checkin', `daily-${athlete.id}-${date}`, { athlete_id: athlete.id });
      enqueued++;
    }

    return NextResponse.json({ ...base, enqueued, paused, postEventPaused, dryRun });
  } catch (err) {
    Sentry.captureException(err);
    console.error('[daily-checkin cron] error', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
