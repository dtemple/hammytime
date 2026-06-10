import { randomBytes } from 'crypto';
import { supabaseAdmin } from '@/lib/db';

const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;

// Purposes this module mints: long-lived (5y), reusable, per-athlete tokens.
// One-shot purposes ('start', 'plan_paste') are minted elsewhere.
type LinkPurpose = 'calendar' | 'prehab';

export function appBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  return raw.replace(/\/+$/, '');
}

export function calendarUrlForToken(token: string): string {
  return `${appBaseUrl()}/api/calendar/${token}.ics`;
}

export function prehabUrlForToken(token: string): string {
  return `${appBaseUrl()}/prehab/${token}`;
}

async function getOrCreateLinkToken(
  athleteId: string,
  purpose: LinkPurpose,
  urlFor: (token: string) => string,
): Promise<{ token: string; url: string }> {
  const db = supabaseAdmin();

  const { data: existing } = await db
    .from('link_tokens')
    .select('token, expires_at')
    .eq('athlete_id', athleteId)
    .eq('purpose', purpose)
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    return { token: existing.token, url: urlFor(existing.token) };
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + FIVE_YEARS_MS).toISOString();

  const { error } = await db.from('link_tokens').insert({
    athlete_id: athleteId,
    token,
    purpose,
    expires_at: expiresAt,
  });

  if (error) {
    throw new Error(`Failed to mint ${purpose} token: ${error.message}`);
  }

  return { token, url: urlFor(token) };
}

export async function getOrCreateCalendarToken(
  athleteId: string,
): Promise<{ token: string; url: string }> {
  return getOrCreateLinkToken(athleteId, 'calendar', calendarUrlForToken);
}

export async function getOrCreatePrehabToken(
  athleteId: string,
): Promise<{ token: string; url: string }> {
  return getOrCreateLinkToken(athleteId, 'prehab', prehabUrlForToken);
}
