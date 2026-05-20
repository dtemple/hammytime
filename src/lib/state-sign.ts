import { createHmac, timingSafeEqual } from "crypto";

export interface StatePayload {
  athlete_id: string;
  iat: number;
  nonce: string;
}

const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function getKey(): string {
  const key = process.env.STATE_SIGNING_KEY;
  if (!key) throw new Error("STATE_SIGNING_KEY is not set");
  if (key.length < 32)
    throw new Error("STATE_SIGNING_KEY must be at least 32 characters");
  return key;
}

export function sign(payload: StatePayload): string {
  const key = getKey();
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verify(token: string): StatePayload {
  const key = getKey();
  const dot = token.lastIndexOf(".");
  if (dot === -1) throw new Error("Invalid state token: missing signature");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", key).update(body).digest("base64url");
  // Constant-time comparison to avoid timing attacks
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    throw new Error("Invalid state token: signature mismatch");
  }
  const payload: StatePayload = JSON.parse(
    Buffer.from(body, "base64url").toString()
  );
  if (Date.now() - payload.iat > MAX_AGE_MS)
    throw new Error("State token expired");
  return payload;
}
