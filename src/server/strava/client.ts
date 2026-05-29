const STRAVA_AUTH_BASE = 'https://www.strava.com/oauth';

function clientId(): string {
  const id = process.env.STRAVA_CLIENT_ID;
  if (!id) throw new Error('STRAVA_CLIENT_ID is not set');
  return id;
}

function clientSecret(): string {
  const secret = process.env.STRAVA_CLIENT_SECRET;
  if (!secret) throw new Error('STRAVA_CLIENT_SECRET is not set');
  return secret;
}

function callbackUrl(): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  return `${base}/strava/callback`;
}

export function getAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: callbackUrl(),
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state,
  });
  return `${STRAVA_AUTH_BASE}/authorize?${params}`;
}

export async function exchangeCode(code: string): Promise<{
  refresh_token: string;
  access_token: string;
  expires_at: number;
  provider_athlete_id: string;
}> {
  const res = await fetch(`${STRAVA_AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Strava token exchange failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return {
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expires_at: data.expires_at,
    provider_athlete_id: String(data.athlete.id),
  };
}

export async function refreshAccessToken(refresh_token: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
}> {
  const res = await fetch(`${STRAVA_AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
      refresh_token,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Strava token refresh failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
  };
}

/**
 * Revokes an access token on Strava's side. After this, the token can no longer
 * read the athlete's data and the connection disappears from the athlete's
 * https://www.strava.com/settings/apps page. Idempotent enough for our use —
 * an already-revoked token returns 401, which we treat as "already gone".
 */
export async function deauthorize(access_token: string): Promise<void> {
  const res = await fetch(`${STRAVA_AUTH_BASE}/deauthorize`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok && res.status !== 401) {
    const body = await res.text();
    throw new Error(`Strava deauthorize failed (${res.status}): ${body}`);
  }
}

export async function pingStrava(): Promise<{
  ok: boolean;
  latency_ms: number;
}> {
  const start = Date.now();
  try {
    const res = await fetch(`${STRAVA_AUTH_BASE}/authorize`, {
      method: 'HEAD',
    });
    const latency_ms = Date.now() - start;
    // Strava redirects HEAD on authorize — any non-5xx is "up"
    return { ok: res.status < 500, latency_ms };
  } catch {
    return { ok: false, latency_ms: Date.now() - start };
  }
}
