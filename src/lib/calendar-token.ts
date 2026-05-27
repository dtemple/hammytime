import { randomBytes } from 'crypto';
import { supabaseAdmin } from '@/lib/db';

const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export function appBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  return raw.replace(/\/+$/, '');
}

export function calendarUrlForToken(token: string): string {
  return `${appBaseUrl()}/api/calendar/${token}.ics`;
}

export async function getOrCreateCalendarToken(
  athleteId: string,
): Promise<{ token: string; url: string }> {
  const db = supabaseAdmin();

  const { data: existing } = await db
    .from('link_tokens')
    .select('token, expires_at')
    .eq('athlete_id', athleteId)
    .eq('purpose', 'calendar')
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    return { token: existing.token, url: calendarUrlForToken(existing.token) };
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + FIVE_YEARS_MS).toISOString();

  const { error } = await db.from('link_tokens').insert({
    athlete_id: athleteId,
    token,
    purpose: 'calendar',
    expires_at: expiresAt,
  });

  if (error) {
    throw new Error(`Failed to mint calendar token: ${error.message}`);
  }

  return { token, url: calendarUrlForToken(token) };
}
