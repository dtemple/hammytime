// Date helpers for the plan engine — ISO yyyy-mm-dd, UTC anchored (deterministic).
//
// Shared by the renderer (week construction) and the selector (timeline count) so
// there is one week-count function, not two subtly-different ones. Lives in its own
// module because renderer.ts imports from selector.ts (nominalRaceMiles), so selector
// importing date helpers from renderer.ts would be circular.

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the ISO week containing `iso` (weeks run Monday→Sunday). */
export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  return addDays(iso, diff);
}

/** Day of week for an ISO date: 0=Sun … 6=Sat. */
export function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** Whole weeks from `fromISO` to `toISO` (floored). Anchor both to Mondays for an
 *  exact, DST-proof count of calendar weeks spanned. */
export function wholeWeeksBetween(fromISO: string, toISO: string): number {
  const ms = Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`);
  return Math.floor(ms / (7 * 24 * 3600 * 1000));
}
