// Thin fetch wrappers over the Google Calendar v3 API (Specs/CALENDAR_OAUTH.md).
// No googleapis dependency — same plain-fetch approach as the Strava client.
// All writes target the athlete's dedicated Daybreak calendar; the
// calendar.app.created scope can't reach anything else.

const API_BASE = 'https://www.googleapis.com/calendar/v3';

// The Google-side representation we read and write. All-day events only:
// start/end carry `date` (end exclusive), never `dateTime`.
export type GoogleEvent = {
  id?: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string };
  end?: { date?: string };
};

function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  return status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body);
}

const RETRY_BASE_MS = 1_000;
const MAX_TRIES = 4;

// Exposed for tests to stub out real sleeping.
export const sleep = { fn: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

/**
 * fetch with backoff-and-retry on rate-limit responses (429, or 403 with a
 * rate-limit reason). Anything else is returned to the caller as-is — callers
 * own their non-2xx semantics (e.g. delete-410 = already gone).
 */
async function apiFetch(url: string, accessToken: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (res.ok || attempt >= MAX_TRIES) return res;
    const body = await res.clone().text();
    if (!isRateLimited(res.status, body)) return res;
    const backoff = RETRY_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    await sleep.fn(backoff);
  }
}

async function fail(res: Response, what: string): Promise<never> {
  const body = await res.text();
  throw new Error(`Google Calendar ${what} failed (${res.status}): ${body}`);
}

export async function insertCalendar(
  accessToken: string,
  input: { summary: string; timeZone: string },
): Promise<{ id: string }> {
  const res = await apiFetch(`${API_BASE}/calendars`, accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) await fail(res, 'calendars.insert');
  const data = await res.json();
  return { id: String(data.id) };
}

/** Deletes the whole secondary calendar. 404/410 = already gone = success. */
export async function deleteCalendar(accessToken: string, calendarId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}`, accessToken, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) await fail(res, 'calendars.delete');
}

/** Lists every live event on the calendar (paginated; tombstones excluded). */
export async function listAllEvents(
  accessToken: string,
  calendarId: string,
): Promise<GoogleEvent[]> {
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: '2500' });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await apiFetch(
      `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      accessToken,
    );
    if (!res.ok) await fail(res, 'events.list');
    const data = await res.json();
    events.push(...((data.items ?? []) as GoogleEvent[]));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return events;
}

/**
 * Imports an event under our iCalUID. If the UID already exists on the
 * calendar (e.g. a cancelled tombstone from a hand-deleted event), Google
 * returns 409 — the caller falls back to a patch that resurrects it.
 */
export async function importEvent(
  accessToken: string,
  calendarId: string,
  event: GoogleEvent,
): Promise<{ conflict: boolean }> {
  const res = await apiFetch(
    `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/import`,
    accessToken,
    { method: 'POST', body: JSON.stringify(event) },
  );
  if (res.status === 409) return { conflict: true };
  if (!res.ok) await fail(res, 'events.import');
  return { conflict: false };
}

/** Looks up an event (including cancelled tombstones) by iCalUID. */
export async function findEventByUid(
  accessToken: string,
  calendarId: string,
  iCalUID: string,
): Promise<GoogleEvent | null> {
  const params = new URLSearchParams({ iCalUID, showDeleted: 'true' });
  const res = await apiFetch(
    `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    accessToken,
  );
  if (!res.ok) await fail(res, 'events.list(iCalUID)');
  const data = await res.json();
  return ((data.items ?? []) as GoogleEvent[])[0] ?? null;
}

export async function patchEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  patch: GoogleEvent,
): Promise<void> {
  const res = await apiFetch(
    `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    accessToken,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  if (!res.ok) await fail(res, 'events.patch');
}

/** Deletes one event. 404/410 = already gone = success. */
export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const res = await apiFetch(
    `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    accessToken,
    { method: 'DELETE' },
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) await fail(res, 'events.delete');
}
