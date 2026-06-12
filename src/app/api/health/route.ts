import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { pingAnthropic } from '@/lib/anthropic';
import { pingTelegram, pingTelegramWebhook } from '@/server/telegram/bot';
import { pingStrava } from '@/server/strava/client';

type PostgresCheck = { ok: boolean; latency_ms: number; error?: string };
type ExternalCheck = {
  ok: boolean;
  configured: boolean;
  latency_ms?: number;
  error?: string;
};
type StravaWebhookCheck = ExternalCheck & { count?: number; callback?: string | null };
type TelegramWebhookCheck = ExternalCheck & {
  url?: string | null;
  pending_update_count?: number;
  last_error?: string | null;
};

const STRAVA_PUSH_SUBSCRIPTIONS_URL = 'https://www.strava.com/api/v3/push_subscriptions';

async function checkPostgres(): Promise<PostgresCheck> {
  const start = Date.now();
  try {
    const { error } = await supabaseAdmin().from('athletes').select('id').limit(1);
    const latency_ms = Date.now() - start;
    if (error) return { ok: false, latency_ms, error: error.message };
    return { ok: true, latency_ms };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - start, error: String(err) };
  }
}

async function checkAnthropic(): Promise<ExternalCheck> {
  const configured = !!process.env.ANTHROPIC_API_KEY;
  if (!configured) return { ok: false, configured };
  try {
    const { latency_ms } = await pingAnthropic();
    return { ok: true, configured, latency_ms };
  } catch (err) {
    return { ok: false, configured, error: String(err) };
  }
}

async function checkTelegram(): Promise<ExternalCheck> {
  const configured = !!process.env.TELEGRAM_BOT_TOKEN;
  if (!configured) return { ok: false, configured };
  try {
    const { latency_ms } = await pingTelegram();
    return { ok: true, configured, latency_ms };
  } catch (err) {
    return { ok: false, configured, error: String(err) };
  }
}

// Confirms Telegram has a webhook registered (prod runs webhook mode). With no
// webhook, Telegram delivers no updates and the bot is silently deaf to every
// message — getMe() still succeeds, so checkTelegram above stays green and hides
// it. Mirrors checkStravaWebhook: ok=false when webhook mode is on but no url is
// registered (or Telegram reports a delivery error), so /api/health goes degraded.
// In polling mode (local dev) a missing webhook is expected, so this is a no-op.
async function checkTelegramWebhook(): Promise<TelegramWebhookCheck> {
  const configured = !!process.env.TELEGRAM_BOT_TOKEN;
  if (!configured) return { ok: false, configured: false };

  const webhookMode = (process.env.TELEGRAM_BOT_MODE ?? 'webhook') !== 'polling';
  if (!webhookMode) return { ok: true, configured: true };

  try {
    const info = await pingTelegramWebhook();
    const hasUrl = info.url.length > 0;
    const hasError = !!info.last_error_message;
    const error = !hasUrl
      ? 'no webhook registered'
      : hasError
        ? info.last_error_message
        : undefined;
    return {
      ok: hasUrl && !hasError,
      configured: true,
      latency_ms: info.latency_ms,
      url: info.url || null,
      pending_update_count: info.pending_update_count,
      last_error: info.last_error_message ?? null,
      ...(error ? { error } : {}),
    };
  } catch (err) {
    return { ok: false, configured: true, error: String(err) };
  }
}

async function checkStrava(): Promise<ExternalCheck> {
  const configured = !!process.env.STRAVA_CLIENT_ID;
  if (!configured) return { ok: false, configured };
  try {
    const { ok, latency_ms } = await pingStrava();
    return { ok, configured, latency_ms };
  } catch (err) {
    return { ok: false, configured, error: String(err) };
  }
}

// Confirms a Strava push subscription exists. Without one, Strava delivers no
// activity events and the post-activity coaching trigger silently never fires
// (SPEC §3.5) — exactly the failure that went unnoticed because nothing surfaced
// it. ok=false when configured but zero subscriptions, so /api/health goes
// degraded instead of staying green on a broken integration.
async function checkStravaWebhook(): Promise<StravaWebhookCheck> {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, configured: false };
  const start = Date.now();
  try {
    const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
    const res = await fetch(`${STRAVA_PUSH_SUBSCRIPTIONS_URL}?${params}`);
    const latency_ms = Date.now() - start;
    if (!res.ok) return { ok: false, configured: true, latency_ms, error: `strava ${res.status}` };
    const subs = (await res.json()) as Array<{ callback_url?: string }>;
    const count = Array.isArray(subs) ? subs.length : 0;
    return {
      ok: count >= 1,
      configured: true,
      count,
      callback: subs[0]?.callback_url ?? null,
      latency_ms,
    };
  } catch (err) {
    return { ok: false, configured: true, latency_ms: Date.now() - start, error: String(err) };
  }
}

export async function GET() {
  const [postgres, anthropic, telegram, telegramWebhook, strava, stravaWebhook] = await Promise.all(
    [
      checkPostgres(),
      checkAnthropic(),
      checkTelegram(),
      checkTelegramWebhook(),
      checkStrava(),
      checkStravaWebhook(),
    ],
  );

  const configuredFailing = [anthropic, telegram, telegramWebhook, strava, stravaWebhook].some(
    (c) => c.configured && !c.ok,
  );

  let status: 'ok' | 'degraded' | 'error';
  if (!postgres.ok) {
    status = 'error';
  } else {
    status = configuredFailing ? 'degraded' : 'ok';
  }

  return NextResponse.json(
    {
      status,
      timestamp: new Date().toISOString(),
      checks: { postgres, anthropic, telegram, telegramWebhook, strava, stravaWebhook },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
