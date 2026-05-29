import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/db';
import { disconnectStrava } from '@/server/strava/disconnect';
import { sendAndLog } from '@/server/telegram/bot';

/**
 * Strava webhook receiver.
 *
 * GET  — subscription validation handshake. Strava calls this once when we
 *        create the push subscription; we echo back the challenge if the
 *        verify token matches.
 * POST — activity + athlete events. We act only on the deauthorization event
 *        (object_type='athlete', updates.authorized='false'): delete our copy
 *        of the athlete's token (compliance) and tell them in Telegram.
 *        Activity events are no-ops — we persist no Strava activity data.
 *
 * Strava disables a subscription that errors or times out, so POST ALWAYS
 * returns 200 quickly; every failure is swallowed to Sentry. Strava does not
 * sign event POSTs, so there is no signature to verify.
 */

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const mode = searchParams.get('hub.mode');
  const challenge = searchParams.get('hub.challenge');
  const verifyToken = searchParams.get('hub.verify_token');

  const expected = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN ?? '';

  if (mode === 'subscribe' && challenge && expected && verifyToken === expected) {
    return NextResponse.json({ 'hub.challenge': challenge });
  }

  return new NextResponse(null, { status: 403 });
}

type StravaEvent = {
  object_type?: string;
  object_id?: number;
  aspect_type?: string;
  owner_id?: number;
  subscription_id?: number;
  updates?: Record<string, string>;
};

export async function POST(req: NextRequest) {
  try {
    const event = (await req.json()) as StravaEvent;

    // Optionally pin events to our one subscription, if the id is configured.
    const expectedSub = process.env.STRAVA_SUBSCRIPTION_ID;
    if (expectedSub && String(event.subscription_id) !== expectedSub) {
      return new NextResponse('ok', { status: 200 });
    }

    const isDeauth =
      event.object_type === 'athlete' && event.updates?.authorized === 'false';

    if (isDeauth && event.owner_id != null) {
      await handleDeauthorization(String(event.owner_id));
    }
    // Activity events (and everything else) are no-ops — nothing is stored.
  } catch (err) {
    Sentry.captureException(err);
  }

  // Always 200, always fast — Strava disables subscriptions that don't.
  return new NextResponse('ok', { status: 200 });
}

async function handleDeauthorization(providerAthleteId: string): Promise<void> {
  const db = supabaseAdmin();

  // Resolve the Strava athlete id → our athlete before we delete the row.
  const { data: token } = await db
    .from('oauth_tokens')
    .select('athlete_id')
    .eq('provider', 'strava')
    .eq('provider_athlete_id', providerAthleteId)
    .maybeSingle();

  if (!token) return; // No connection on file — already gone.

  const athleteId = token.athlete_id as string;

  await disconnectStrava(athleteId, { revokeOnStrava: false });

  // Tell the athlete their data link is gone — best-effort.
  const { data: athlete } = await db
    .from('athletes')
    .select('id, telegram_chat_id')
    .eq('id', athleteId)
    .maybeSingle();

  if (athlete?.telegram_chat_id) {
    await sendAndLog(
      athlete.id,
      athlete.telegram_chat_id,
      "You disconnected Strava, so I've removed it from your account. I won't see your training until you reconnect with /connect_strava.",
    );
  }
}
