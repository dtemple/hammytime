// Google OAuth client for the calendar direct-write path (Specs/CALENDAR_OAUTH.md).
// Same shape as src/server/strava/client.ts: plain fetch, env-read-on-use,
// throw with status + body on failure.

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

function clientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error('GOOGLE_CLIENT_ID is not set');
  return id;
}

function clientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error('GOOGLE_CLIENT_SECRET is not set');
  return secret;
}

function callbackUrl(): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  return `${base}/google/callback`;
}

export function getAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: callbackUrl(),
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    // offline + consent guarantees a refresh_token in the exchange — Google
    // only returns one on a consented grant, and the background writer is
    // dead without it.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

export async function exchangeCode(code: string): Promise<{
  access_token: string;
  refresh_token: string | null;
  expires_at: number; // unix seconds, absolute
  scope: string;
}> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrl(),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return {
    access_token: data.access_token,
    // Absent when the user previously consented without prompt=consent — the
    // callback rejects that case rather than storing a row that can't refresh.
    refresh_token: data.refresh_token ?? null,
    expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in ?? 0),
    scope: String(data.scope ?? ''),
  };
}

export class GoogleAuthRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthRevokedError';
  }
}

// Unlike Strava, Google does NOT return a new refresh_token on refresh — the
// original keeps working until revoked. Callers must keep the stored one.
export async function refreshAccessToken(refresh_token: string): Promise<{
  access_token: string;
  expires_at: number; // unix seconds, absolute
}> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
      refresh_token,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // invalid_grant = the user revoked access (or the token expired beyond
    // recovery). A typed error so callers can tear down the connection
    // instead of retrying forever.
    if (res.status === 400 && body.includes('invalid_grant')) {
      throw new GoogleAuthRevokedError(`Google refresh token revoked: ${body}`);
    }
    throw new Error(`Google token refresh failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return {
    access_token: data.access_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in ?? 0),
  };
}

/**
 * Revokes a token on Google's side. Revoking either token kills the whole
 * grant. Already-invalid tokens return 400 — treat as "already gone".
 */
export async function revokeToken(token: string): Promise<void> {
  const res = await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok && res.status !== 400) {
    const body = await res.text();
    throw new Error(`Google token revoke failed (${res.status}): ${body}`);
  }
}
