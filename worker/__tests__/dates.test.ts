import { describe, it, expect } from 'vitest';
import { isValidTimeZone, localDate } from '../dates';

describe('localDate', () => {
  // A mid-morning UTC instant: still the same calendar day west of UTC, already
  // the next day far enough east — so the zone actually changes the answer.
  const at = new Date('2026-06-24T09:30:00Z');

  it('formats YYYY-MM-DD in the given zone', () => {
    expect(localDate(at, 'America/Los_Angeles')).toBe('2026-06-24'); // 02:30 local
    expect(localDate(at, 'Australia/Sydney')).toBe('2026-06-24'); // 19:30 local
  });

  it('rolls the date across the UTC boundary by zone', () => {
    // 23:30 UTC: previous day in LA, next day in Sydney.
    const late = new Date('2026-06-24T23:30:00Z');
    expect(localDate(late, 'America/Los_Angeles')).toBe('2026-06-24'); // 16:30 local
    expect(localDate(late, 'Australia/Sydney')).toBe('2026-06-25'); // 09:30 local
  });

  it('handles a US DST date (PDT, UTC-7)', () => {
    // July → daylight time. 06:00 UTC is 23:00 the prior day in PDT.
    const dst = new Date('2026-07-15T06:00:00Z');
    expect(localDate(dst, 'America/Los_Angeles')).toBe('2026-07-14');
  });

  it('falls back to America/Los_Angeles for an invalid zone', () => {
    expect(localDate(at, 'Not/AZone')).toBe(localDate(at, 'America/Los_Angeles'));
  });
});

describe('isValidTimeZone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
