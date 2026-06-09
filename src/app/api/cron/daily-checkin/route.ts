import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/db';
import { nowInTimezone } from '@/server/telegram/checkin/dispatcher';
import { enqueueJob } from '@/server/jobs/enqueue';
import { isOnboarded } from '@/server/telegram/onboarding';

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

    // Enqueue one daily coaching job per onboarded athlete; the worker drains
    // them and runs the agent. The per-day unique key (in the athlete's local
    // timezone) makes a cron overlap a no-op. enqueueJob throws on a DB error,
    // so a per-athlete failure aborts the batch — the next cron tick retries the
    // not-yet-enqueued athletes (their keys are still free).
    let enqueued = 0;
    for (const athlete of onboarded) {
      const { date } = nowInTimezone(athlete.timezone);
      await enqueueJob('daily_checkin', `daily-${athlete.id}-${date}`, { athlete_id: athlete.id });
      enqueued++;
    }

    return NextResponse.json({ ok: true, enqueued });
  } catch (err) {
    Sentry.captureException(err);
    console.error('[daily-checkin cron] error', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
