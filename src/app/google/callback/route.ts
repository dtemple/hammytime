import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { verify } from '@/lib/state-sign';
import { CALENDAR_SCOPE, exchangeCode } from '@/server/google/client';
import { insertCalendar } from '@/server/google/calendar-api';
import { encryptToken } from '@/lib/crypto';
import { supabaseAdmin } from '@/lib/db';
import { sendAndLog } from '@/server/telegram/bot';
import { enqueueJob } from '@/server/jobs/enqueue';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get('code');
  const stateToken = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    // The athlete hit "Cancel" on the consent screen (access_denied) or
    // Google errored. Either way, land them on the result page, not JSON.
    return NextResponse.redirect(
      new URL(`/google/connected?error=${encodeURIComponent(error)}`, req.nextUrl.origin),
    );
  }
  if (!code || !stateToken) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  let athleteId: string;
  try {
    const payload = verify(stateToken);
    athleteId = payload.athlete_id;
  } catch (err) {
    return NextResponse.json({ error: `Invalid state: ${String(err)}` }, { status: 400 });
  }

  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(code);
  } catch (err) {
    return NextResponse.json({ error: `Token exchange failed: ${String(err)}` }, { status: 502 });
  }

  // Google lets users untick individual scopes on the consent screen. Without
  // calendar.app.created every write would 403 — reject up front.
  if (!tokens.scope.includes(CALENDAR_SCOPE)) {
    return NextResponse.redirect(
      new URL('/google/connected?error=insufficient_scope', req.nextUrl.origin),
    );
  }

  // No refresh token = nothing for the background writer to run on. Shouldn't
  // happen with prompt=consent, but don't store a connection that dies in an hour.
  if (!tokens.refresh_token) {
    return NextResponse.redirect(
      new URL('/google/connected?error=no_refresh_token', req.nextUrl.origin),
    );
  }

  const db = supabaseAdmin();
  const { data: athlete } = await db
    .from('athletes')
    .select('id, timezone, telegram_chat_id')
    .eq('id', athleteId)
    .maybeSingle();
  if (!athlete) {
    return NextResponse.json({ error: 'Unknown athlete' }, { status: 400 });
  }

  // Reuse an existing Daybreak calendar if this athlete reconnects while one
  // is already on file — creating a second would leave duplicate events.
  const { data: existing } = await db
    .from('oauth_tokens')
    .select('provider_calendar_id')
    .eq('athlete_id', athleteId)
    .eq('provider', 'google_calendar')
    .maybeSingle();

  let calendarId = existing?.provider_calendar_id ?? null;
  if (!calendarId) {
    try {
      const cal = await insertCalendar(tokens.access_token, {
        summary: 'Daybreak — training',
        timeZone: athlete.timezone,
      });
      calendarId = cal.id;
    } catch (err) {
      return NextResponse.json(
        { error: `Calendar create failed: ${String(err)}` },
        { status: 502 },
      );
    }
  }

  const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
    encryptToken(tokens.access_token),
    encryptToken(tokens.refresh_token),
  ]);

  const { error: upsertErr } = await db.from('oauth_tokens').upsert(
    {
      athlete_id: athleteId,
      provider: 'google_calendar',
      access_token_enc: accessTokenEnc,
      refresh_token_enc: refreshTokenEnc,
      expires_at: new Date(tokens.expires_at * 1000).toISOString(),
      provider_calendar_id: calendarId,
    },
    { onConflict: 'athlete_id,provider' },
  );

  if (upsertErr) {
    return NextResponse.json({ error: `DB upsert failed: ${upsertErr.message}` }, { status: 500 });
  }

  // The ~154-event first fill belongs in the worker (retries, throttling), not
  // a Vercel request. The worker drains within seconds.
  try {
    await enqueueJob('calendar_sync', `calsync-${athleteId}-connect-${Date.now()}`, {
      athlete_id: athleteId,
      reason: 'connect',
    });
  } catch (err) {
    Sentry.captureException(err);
    // The nightly reconcile will fill the calendar if the enqueue failed.
  }

  // Telegram side — best-effort, never fails the callback.
  try {
    if (athlete.telegram_chat_id) {
      await sendAndLog(
        athlete.id,
        athlete.telegram_chat_id,
        "Google Calendar connected. Your workouts are landing in a new 'Daybreak — training' calendar now — plan changes show up there within seconds.",
      );
    }
  } catch (err) {
    Sentry.captureException(err);
  }

  return NextResponse.redirect(new URL('/google/connected', req.nextUrl.origin));
}
