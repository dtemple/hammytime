import { supabaseAdmin } from "@/lib/db";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { refreshAccessToken } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StravaActivitySummary = {
  id: number;
  name: string;
  type: string;                    // "Run", "TrailRun", "VirtualRun", etc.
  start_date_local: string;        // ISO datetime in athlete's local time
  distance_m: number;
  moving_time_s: number;
  elapsed_time_s: number;
  total_elevation_gain_m: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  average_speed_mps: number;
};

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/**
 * Loads, validates, and (if needed) refreshes the Strava access token for an
 * athlete. Returns the decrypted access token string, or null if the athlete
 * has no connected Strava account.
 */
async function getAccessToken(athleteId: string): Promise<string | null> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("oauth_tokens")
    .select("access_token_enc, refresh_token_enc, expires_at")
    .eq("athlete_id", athleteId)
    .eq("provider", "strava")
    .maybeSingle();

  if (!data) return null;

  const expiresAt = new Date(data.expires_at).getTime();
  const nowPlusFiveMin = Date.now() + 5 * 60 * 1000;

  if (expiresAt > nowPlusFiveMin) {
    // Token is still valid.
    return decryptToken(data.access_token_enc);
  }

  // Token is expired or about to expire — refresh it.
  const refreshToken = await decryptToken(data.refresh_token_enc);
  const refreshed = await refreshAccessToken(refreshToken);

  // Re-encrypt and persist.
  const [newAccessEnc, newRefreshEnc] = await Promise.all([
    encryptToken(refreshed.access_token),
    encryptToken(refreshed.refresh_token),
  ]);

  await db
    .from("oauth_tokens")
    .update({
      access_token_enc: newAccessEnc,
      refresh_token_enc: newRefreshEnc,
      expires_at: new Date(refreshed.expires_at * 1000).toISOString(),
    })
    .eq("athlete_id", athleteId)
    .eq("provider", "strava");

  return refreshed.access_token;
}

// ---------------------------------------------------------------------------
// Strava API call
// ---------------------------------------------------------------------------

const STRAVA_API_BASE = "https://www.strava.com/api/v3";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapActivity(raw: any): StravaActivitySummary {
  return {
    id: raw.id,
    name: raw.name ?? "",
    type: raw.sport_type ?? raw.type ?? "Unknown",
    start_date_local: raw.start_date_local ?? raw.start_date ?? "",
    distance_m: raw.distance ?? 0,
    moving_time_s: raw.moving_time ?? 0,
    elapsed_time_s: raw.elapsed_time ?? 0,
    total_elevation_gain_m: raw.total_elevation_gain ?? 0,
    average_heartrate: raw.average_heartrate ?? null,
    max_heartrate: raw.max_heartrate ?? null,
    average_speed_mps: raw.average_speed ?? 0,
  };
}

async function callStravaActivities(
  accessToken: string,
  afterUnix: number
): Promise<StravaActivitySummary[]> {
  const url = `${STRAVA_API_BASE}/athlete/activities?after=${afterUnix}&per_page=50`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    // Caller will handle the 401 case by retrying after refresh.
    throw Object.assign(new Error("Strava 401 Unauthorized"), { status: 401 });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Strava activities fetch failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return (Array.isArray(data) ? data : []).map(mapActivity);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the athlete has a Strava oauth_tokens row on file.
 *
 * Does not decrypt or validate the token. Use this to distinguish
 * "no connection" from "connected but no recent activities" before
 * calling fetchRecentActivities — the latter returns [] silently for
 * both cases, which is ambiguous.
 */
export async function hasStravaConnection(athleteId: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from("oauth_tokens")
    .select("id")
    .eq("athlete_id", athleteId)
    .eq("provider", "strava")
    .maybeSingle();
  return !!data;
}

/**
 * Returns the last `days` days of Strava activities for an athlete.
 *
 * Returns an empty array if:
 * - The athlete has no connected Strava account.
 * - There are no activities in the window.
 *
 * Throws on non-401 Strava errors or token decrypt failures.
 */
export async function fetchRecentActivities(
  athleteId: string,
  days = 14
): Promise<StravaActivitySummary[]> {
  const afterUnix = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

  let accessToken = await getAccessToken(athleteId);
  if (!accessToken) return [];

  try {
    return await callStravaActivities(accessToken, afterUnix);
  } catch (err: unknown) {
    // On 401, try one token refresh + retry.
    const errStatus = (err as { status?: number }).status;
    if (errStatus === 401) {
      // Re-fetch with a forced refresh: clear the cached token expiry by
      // setting a past expires_at so getAccessToken will refresh.
      const db = supabaseAdmin();
      await db
        .from("oauth_tokens")
        .update({ expires_at: new Date(0).toISOString() })
        .eq("athlete_id", athleteId)
        .eq("provider", "strava");

      accessToken = await getAccessToken(athleteId);
      if (!accessToken) return [];
      return await callStravaActivities(accessToken, afterUnix);
    }
    throw err;
  }
}
