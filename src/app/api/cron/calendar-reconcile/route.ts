// Nightly Google Calendar reconcile (Specs/CALENDAR_OAUTH.md) — the safety
// net under the event-driven calendar_sync triggers. Self-healing against
// missed enqueues, partial syncs, and athlete hand-edits; a clean run is one
// events.list per connected athlete and zero writes.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/db';
import { enqueueJob } from '@/server/jobs/enqueue';

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
    const { data: connections, error } = await supabaseAdmin()
      .from('oauth_tokens')
      .select('athlete_id')
      .eq('provider', 'google_calendar');
    if (error) throw new Error(`oauth_tokens query failed: ${error.message}`);

    if (!connections || connections.length === 0) {
      return NextResponse.json({ ok: true, skipped: 'no_connected_athletes' });
    }

    // Per-day unique key (UTC date — the exact boundary doesn't matter for a
    // safety net) makes a cron overlap a no-op.
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let enqueued = 0;
    for (const conn of connections) {
      await enqueueJob('calendar_sync', `calsync-${conn.athlete_id}-nightly-${date}`, {
        athlete_id: conn.athlete_id,
        reason: 'nightly',
      });
      enqueued++;
    }

    return NextResponse.json({ ok: true, enqueued });
  } catch (err) {
    Sentry.captureException(err);
    console.error('[calendar-reconcile cron] error', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
