import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/db';
import { nowInTimezone } from '@/server/telegram/checkin/dispatcher';
import { enqueueJob } from '@/server/jobs/enqueue';
import { onboardingSteps } from '@/server/telegram/onboarding';

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
      const step = (a.onboarding_state as { step?: number } | null)?.step ?? 0;
      return step >= onboardingSteps.length;
    });

    if (onboarded.length === 0) {
      return NextResponse.json({ ok: true, skipped: 'no_onboarded_athlete' });
    }
    if (onboarded.length > 1) {
      console.warn(
        `[daily-checkin cron] multiple onboarded athletes (${onboarded.length}); picking first`,
      );
    }

    const athlete = onboarded[0];

    // Enqueue the daily coaching job; the worker runs the agent and then sends
    // the wellness battery (SPEC §3.7). The per-day unique key makes a cron
    // overlap a no-op — no inline run, no inline battery here anymore.
    const { date } = nowInTimezone(athlete.timezone);
    await enqueueJob('daily_checkin', `daily-${athlete.id}-${date}`, { athlete_id: athlete.id });

    return NextResponse.json({ ok: true, enqueued: athlete.id });
  } catch (err) {
    Sentry.captureException(err);
    console.error('[daily-checkin cron] error', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
