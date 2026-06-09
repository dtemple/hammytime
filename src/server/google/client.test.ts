import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CALENDAR_SCOPE,
  GoogleAuthRevokedError,
  exchangeCode,
  getAuthorizeUrl,
  refreshAccessToken,
  revokeToken,
} from './client';

const realFetch = global.fetch;

function mockFetchOnce(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'gid';
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
  process.env.NEXT_PUBLIC_APP_URL = 'https://daybreak.run';
});

afterEach(() => {
  global.fetch = realFetch;
  vi.clearAllMocks();
});

describe('getAuthorizeUrl', () => {
  it('carries the calendar scope, offline access, forced consent, and state', () => {
    const url = new URL(getAuthorizeUrl('state-123'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('gid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://daybreak.run/google/callback');
    expect(url.searchParams.get('scope')).toBe(CALENDAR_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-123');
  });

  it('throws when GOOGLE_CLIENT_ID is missing', () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(() => getAuthorizeUrl('s')).toThrow(/GOOGLE_CLIENT_ID/);
  });
});

describe('exchangeCode', () => {
  it('maps expires_in to an absolute timestamp and surfaces scope', async () => {
    mockFetchOnce(200, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      scope: CALENDAR_SCOPE,
    });
    const before = Math.floor(Date.now() / 1000);
    const tokens = await exchangeCode('code-1');
    expect(tokens.access_token).toBe('at');
    expect(tokens.refresh_token).toBe('rt');
    expect(tokens.scope).toBe(CALENDAR_SCOPE);
    expect(tokens.expires_at).toBeGreaterThanOrEqual(before + 3600);
    expect(tokens.expires_at).toBeLessThanOrEqual(before + 3601);
  });

  it('returns refresh_token null when Google omits it', async () => {
    mockFetchOnce(200, { access_token: 'at', expires_in: 3600, scope: CALENDAR_SCOPE });
    const tokens = await exchangeCode('code-1');
    expect(tokens.refresh_token).toBeNull();
  });

  it('throws with status and body on a non-OK response', async () => {
    mockFetchOnce(400, '{"error":"invalid_request"}');
    await expect(exchangeCode('bad')).rejects.toThrow(/exchange failed \(400\)/);
  });
});

describe('refreshAccessToken', () => {
  it('returns a new access token and never a refresh token', async () => {
    mockFetchOnce(200, { access_token: 'new-at', expires_in: 3600 });
    const refreshed = await refreshAccessToken('rt');
    expect(refreshed.access_token).toBe('new-at');
    // Google refresh responses carry no refresh_token — the shape must not
    // pretend otherwise, or a caller could overwrite the stored one with junk.
    expect('refresh_token' in refreshed).toBe(false);
  });

  it('throws GoogleAuthRevokedError on 400 invalid_grant', async () => {
    mockFetchOnce(400, '{"error":"invalid_grant","error_description":"Token has been revoked."}');
    await expect(refreshAccessToken('rt')).rejects.toBeInstanceOf(GoogleAuthRevokedError);
  });

  it('throws a plain error on other failures', async () => {
    mockFetchOnce(500, 'server error');
    const err = await refreshAccessToken('rt').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GoogleAuthRevokedError);
  });
});

describe('revokeToken', () => {
  it('treats 400 (already invalid) as success', async () => {
    mockFetchOnce(400, '{"error":"invalid_token"}');
    await expect(revokeToken('dead')).resolves.toBeUndefined();
  });

  it('throws on other failures', async () => {
    mockFetchOnce(500, 'nope');
    await expect(revokeToken('t')).rejects.toThrow(/revoke failed \(500\)/);
  });
});
