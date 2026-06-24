// David-only admin console — password gate + signed session cookie
// (Specs/METERING_PAYMENTS.md §11, step 7).
//
// The console lives on the deployed Daybreak domain behind a single shared
// password (ADMIN_PASSWORD), not a local-only tool and not per-user accounts.
// On a correct password we mint a signed, httpOnly, Secure cookie; the admin
// routes verify it. The signature reuses the same HMAC-over-STATE_SIGNING_KEY
// shape as src/lib/state-sign.ts, but with its own 7-day expiry (the OAuth-state
// signer is a 10-minute single-use token — wrong lifetime for a session).
//
// ADMIN_PASSWORD must be set on Vercel (and .env.local) for the gate to work —
// until it is, checkAdminPassword always returns false and nobody gets in.

import { createHmac, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';

export const ADMIN_COOKIE = 'admin_session';
export const ADMIN_SESSION_MAX_AGE_S = 7 * 24 * 60 * 60; // 7 days

interface AdminSessionPayload {
  iat: number;
}

function getKey(): string {
  const key = process.env.STATE_SIGNING_KEY;
  if (!key) throw new Error('STATE_SIGNING_KEY is not set');
  if (key.length < 32) throw new Error('STATE_SIGNING_KEY must be at least 32 characters');
  return key;
}

/** Sign a fresh admin-session token (issued-at stamped now). */
export function signAdminSession(): string {
  const key = getKey();
  const payload: AdminSessionPayload = { iat: Date.now() };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** True if the token's signature is valid and it hasn't aged past the lifetime. */
export function verifyAdminSession(token: string | undefined): boolean {
  if (!token) return false;
  let key: string;
  try {
    key = getKey();
  } catch {
    return false;
  }
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', key).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }
  try {
    const payload: AdminSessionPayload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof payload.iat !== 'number') return false;
    return Date.now() - payload.iat <= ADMIN_SESSION_MAX_AGE_S * 1000;
  } catch {
    return false;
  }
}

/**
 * Constant-time compare of a submitted password against ADMIN_PASSWORD. Returns
 * false (never throws) when the env var is unset — so a misconfigured prod fails
 * closed rather than open.
 */
export function checkAdminPassword(input: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Compare equal-length buffers anyway to keep timing independent of length.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Read + verify the session cookie. Used by the route guard and the server actions. */
export async function isAdminAuthed(): Promise<boolean> {
  const jar = await cookies();
  return verifyAdminSession(jar.get(ADMIN_COOKIE)?.value);
}
