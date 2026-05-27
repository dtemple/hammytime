import type { ParseResult } from '../types';

const KM_TO_MI = 0.621371;

const NAMED_ALIASES: Record<string, number> = {
  '5k': 3.107,
  '5km': 3.107,
  '10k': 6.214,
  '10km': 6.214,
  half: 13.1,
  'half marathon': 13.1,
  hm: 13.1,
  '13.1': 13.1,
  marathon: 26.2,
  'full marathon': 26.2,
  '26.2': 26.2,
  ultra: 50,
  ultramarathon: 50,
  '50k': 31.069,
  '50m': 50,
  '100k': 62.137,
  '100m': 100,
};

// Returns distance in miles.
export function parseDistanceMiles(text: string): ParseResult<number> {
  const v = text.trim().toLowerCase().replace(/\s+/g, ' ');

  const named = NAMED_ALIASES[v];
  if (named !== undefined) return { ok: true, value: named };

  // "42.2 km" / "42.2km"
  const km = /^([\d.]+)\s*km$/.exec(v);
  if (km) {
    const n = parseFloat(km[1]!);
    if (isNaN(n) || n <= 0) return { ok: false, error: 'Distance must be a positive number.' };
    return { ok: true, value: Math.round(n * KM_TO_MI * 10) / 10 };
  }

  // "26.2 mi" / "26.2mi" / "26.2 miles" / bare "26.2"
  const mi = /^([\d.]+)\s*(?:mi(?:les?)?)?$/.exec(v);
  if (mi) {
    const n = parseFloat(mi[1]!);
    if (isNaN(n) || n <= 0) return { ok: false, error: 'Distance must be a positive number.' };
    return { ok: true, value: n };
  }

  return {
    ok: false,
    error:
      "Send a distance like '26.2 mi', '42.2 km', 'marathon', 'half', '5k', '10k', or 'ultra'.",
  };
}
