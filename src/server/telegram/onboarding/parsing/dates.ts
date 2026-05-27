import type { ParseResult } from '../types';

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function inferYear(month: number, day: number): number {
  const now = new Date();
  const year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  // If the date is in the past, assume next year.
  return candidate <= now ? year + 1 : year;
}

function padded(n: number): string {
  return String(n).padStart(2, '0');
}

export function parseDateFlexible(text: string): ParseResult<string> {
  const v = text.trim();

  // ISO: YYYY-MM-DD
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) {
    const [, y, m, d] = iso;
    const date = new Date(`${y}-${m}-${d}T00:00:00`);
    if (isNaN(date.getTime())) return { ok: false, error: "That date doesn't look valid." };
    return { ok: true, value: `${y}-${m}-${d}` };
  }

  // Slash: MM/DD/YYYY or MM/DD/YY
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(v);
  if (slash) {
    const month = parseInt(slash[1]!, 10);
    const day = parseInt(slash[2]!, 10);
    let year = parseInt(slash[3]!, 10);
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31)
      return { ok: false, error: "That date doesn't look valid." };
    return { ok: true, value: `${year}-${padded(month)}-${padded(day)}` };
  }

  // "Aug 30 2026", "August 30, 2026", "30 Aug 2026"
  const named =
    /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(v) || // "Aug 30 2026"
    /^(\d{1,2})\s+([a-z]+),?\s+(\d{4})$/i.exec(v); // "30 Aug 2026"

  if (named) {
    let monthStr: string, dayStr: string, yearStr: string;
    // Determine field order by checking whether first capture is alpha or numeric
    if (/^\d/.test(named[1]!)) {
      // "30 Aug 2026" form
      dayStr = named[1]!;
      monthStr = named[2]!;
      yearStr = named[3]!;
    } else {
      // "Aug 30 2026" form
      monthStr = named[1]!;
      dayStr = named[2]!;
      yearStr = named[3]!;
    }
    const month = MONTH_NAMES[monthStr.toLowerCase()];
    if (!month) return { ok: false, error: "Couldn't parse that month name." };
    const day = parseInt(dayStr, 10);
    const year = parseInt(yearStr, 10);
    if (day < 1 || day > 31) return { ok: false, error: "That date doesn't look valid." };
    return { ok: true, value: `${year}-${padded(month)}-${padded(day)}` };
  }

  // "Aug 30" or "August 30" — no year, infer year
  const namedNoYear = /^([a-z]+)\s+(\d{1,2})$/i.exec(v) || /^(\d{1,2})\s+([a-z]+)$/i.exec(v);

  if (namedNoYear) {
    let monthStr: string, dayStr: string;
    if (/^\d/.test(namedNoYear[1]!)) {
      dayStr = namedNoYear[1]!;
      monthStr = namedNoYear[2]!;
    } else {
      monthStr = namedNoYear[1]!;
      dayStr = namedNoYear[2]!;
    }
    const month = MONTH_NAMES[monthStr.toLowerCase()];
    if (!month) return { ok: false, error: "Couldn't parse that month name." };
    const day = parseInt(dayStr, 10);
    if (day < 1 || day > 31) return { ok: false, error: "That date doesn't look valid." };
    const year = inferYear(month, day);
    return { ok: true, value: `${year}-${padded(month)}-${padded(day)}` };
  }

  return {
    ok: false,
    error: 'Send the date as Aug 30 2026, 8/30/2026, or 2026-08-30.',
  };
}
