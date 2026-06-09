import { planToCalendarEvents, type CalendarEvent } from '@/lib/calendar-events';
import { loadCalendarRenderInput } from '@/server/plans/active-plan';
import { getGoogleAccessToken } from './token';
import {
  deleteEvent,
  findEventByUid,
  importEvent,
  listAllEvents,
  patchEvent,
  sleep,
  type GoogleEvent,
} from './calendar-api';

export type ReconcileResult = {
  imported: number;
  patched: number;
  deleted: number;
  skipped: number;
};

// Gap between consecutive writes. Worst case (~154 imports on first fill)
// finishes in ~12s, comfortably under the per-minute quota; a no-op nightly
// reconcile makes one list call and zero writes.
const WRITE_GAP_MS = 75;

function isoPlusOneDay(iso: string): string {
  const parts = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(parts[0] ?? 1970, (parts[1] ?? 1) - 1, (parts[2] ?? 1) + 1));
  return dt.toISOString().slice(0, 10);
}

// Google's all-day end.date is exclusive — +1 day matches the ICS feed's
// 24-hour all-day event exactly.
function toGoogleEvent(e: CalendarEvent): GoogleEvent {
  return {
    iCalUID: e.uid,
    summary: e.summary,
    description: e.description,
    ...(e.location ? { location: e.location } : {}),
    start: { date: e.date },
    end: { date: isoPlusOneDay(e.date) },
  };
}

function norm(v: string | undefined): string {
  return v ?? '';
}

function changed(desired: GoogleEvent, remote: GoogleEvent): boolean {
  return (
    norm(desired.summary) !== norm(remote.summary) ||
    norm(desired.description) !== norm(remote.description) ||
    norm(desired.location) !== norm(remote.location) ||
    norm(desired.start?.date) !== norm(remote.start?.date) ||
    norm(desired.end?.date) !== norm(remote.end?.date)
  );
}

/**
 * Converges the athlete's Daybreak calendar onto the active plan's event set:
 * import what's missing, patch what changed, delete what no longer exists.
 * Idempotent — a wholesale re-run after a partial failure finishes the job.
 * No connection or no active plan → no-op success.
 *
 * Throws on unrecoverable API errors (the job queue retries with backoff) and
 * GoogleAuthRevokedError from the token layer (the job handler tears the
 * connection down).
 */
export async function reconcileCalendar(athleteId: string): Promise<ReconcileResult> {
  const result: ReconcileResult = { imported: 0, patched: 0, deleted: 0, skipped: 0 };

  const conn = await getGoogleAccessToken(athleteId);
  if (!conn?.calendarId) return result;

  const renderInput = await loadCalendarRenderInput(athleteId);
  if (!renderInput) return result;

  const desired = planToCalendarEvents(renderInput).map(toGoogleEvent);
  const remote = await listAllEvents(conn.accessToken, conn.calendarId);
  const remoteByUid = new Map(remote.filter((e) => e.iCalUID).map((e) => [e.iCalUID!, e]));
  const desiredUids = new Set(desired.map((e) => e.iCalUID!));

  for (const event of desired) {
    const existing = remoteByUid.get(event.iCalUID!);
    if (!existing) {
      const { conflict } = await importEvent(conn.accessToken, conn.calendarId, event);
      if (conflict) {
        // The UID exists as a cancelled tombstone (athlete hand-deleted the
        // event). Resurrect it in place.
        const tombstone = await findEventByUid(conn.accessToken, conn.calendarId, event.iCalUID!);
        if (tombstone?.id) {
          await patchEvent(conn.accessToken, conn.calendarId, tombstone.id, {
            ...event,
            status: 'confirmed',
          });
          result.patched++;
        }
      } else {
        result.imported++;
      }
      await sleep.fn(WRITE_GAP_MS);
    } else if (changed(event, existing)) {
      await patchEvent(conn.accessToken, conn.calendarId, existing.id!, event);
      result.patched++;
      await sleep.fn(WRITE_GAP_MS);
    } else {
      result.skipped++;
    }
  }

  // Events on the calendar that the plan no longer contains. Only touch UIDs
  // we minted — an event the athlete added to the Daybreak calendar by hand
  // is theirs, not ours to delete.
  for (const [uid, event] of remoteByUid) {
    if (desiredUids.has(uid) || !uid.endsWith('@hammytime') || !event.id) continue;
    await deleteEvent(conn.accessToken, conn.calendarId, event.id);
    result.deleted++;
    await sleep.fn(WRITE_GAP_MS);
  }

  return result;
}
