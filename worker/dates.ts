// Zoned-date helpers shared across the worker — one en-CA YYYY-MM-DD formatter
// and one timezone validator instead of a copy per file. Worker-only (web has
// its own date utilities in src/lib), so it lives here rather than in src/lib.

// Whether `tz` is an IANA zone Intl will accept — guards against a malformed
// athlete timezone reaching the formatter.
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// YYYY-MM-DD for the instant `at` in `timeZone`. Callers that want "today" pass
// `new Date()`; an explicit `at` keeps this unit-testable without mocking the
// clock. An invalid zone falls back to America/Los_Angeles.
export function localDate(at: Date, timeZone: string): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'America/Los_Angeles';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
