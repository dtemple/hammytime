import { describe, it, expect } from 'vitest';
import {
  resolveFinishTime,
  resolveFinishTimeForMiles,
  paceToFinish,
  finishToPace,
  formatPace,
  deriveBucketFromMiles,
  isPastISODate,
} from '../numeric';

describe('deriveBucketFromMiles (V3-W8)', () => {
  it('buckets in-catalog distances by their bands', () => {
    expect(deriveBucketFromMiles(3.1)).toBe('5k');
    expect(deriveBucketFromMiles(4.6)).toBe('5k'); // just under the 5k/10k split
    expect(deriveBucketFromMiles(6.2)).toBe('10k');
    expect(deriveBucketFromMiles(13.1)).toBe('half');
    expect(deriveBucketFromMiles(16.9)).toBe('half');
    expect(deriveBucketFromMiles(26.2)).toBe('marathon');
    expect(deriveBucketFromMiles(28)).toBe('marathon'); // wide band — a 28mi trail "marathon"
  });

  it('returns null past the current catalog → the pocket', () => {
    expect(deriveBucketFromMiles(31)).toBeNull(); // 50k
    expect(deriveBucketFromMiles(44)).toBeNull(); // Rae Lakes
    expect(deriveBucketFromMiles(100)).toBeNull(); // Western States
  });

  it('returns null below the catalog floor → the pocket (R1 fix 1)', () => {
    expect(deriveBucketFromMiles(1)).toBeNull(); // the Nathan mile — never silently a 5K
    expect(deriveBucketFromMiles(2)).toBeNull();
    expect(deriveBucketFromMiles(2.4)).toBeNull();
    expect(deriveBucketFromMiles(2.5)).toBe('5k'); // the floor itself is in catalog
  });

  it('returns null for nonsense input', () => {
    expect(deriveBucketFromMiles(0)).toBeNull();
    expect(deriveBucketFromMiles(-5)).toBeNull();
    expect(deriveBucketFromMiles(NaN)).toBeNull();
  });
});

describe('resolveFinishTime', () => {
  it('accepts a plausible marathon finish', () => {
    expect(resolveFinishTime(15900, 'marathon')).toEqual({ status: 'ok', seconds: 15900 }); // 4:25:00
  });

  it('flags the "4:25" marathon as ambiguous (four minutes vs four hours)', () => {
    const r = resolveFinishTime(265, 'marathon'); // 4m 25s — impossible for a marathon
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.asHours.seconds).toBe(15900);
      expect(r.asHours.label).toBe('4:25:00');
      expect(r.asMinutes.seconds).toBe(265);
      expect(r.asMinutes.label).toBe('0:04:25');
    }
  });

  it('rejects an out-of-range value whose hours reading is also implausible', () => {
    // 50 sec → hours reading 3000s (50min) is still under the marathon floor (2h).
    expect(resolveFinishTime(50, 'marathon')).toEqual({ status: 'out_of_range', seconds: 50 });
  });

  it('flags a too-slow finish as out_of_range, not ambiguous', () => {
    expect(resolveFinishTime(30000, 'marathon')).toEqual({
      status: 'out_of_range',
      seconds: 30000,
    }); // 8:20:00
  });

  it('accepts a plausible 5k and disambiguates a tiny one', () => {
    expect(resolveFinishTime(1500, '5k')).toEqual({ status: 'ok', seconds: 1500 }); // 25:00
    const r = resolveFinishTime(25, '5k'); // 25s — would be 25:00 in minutes
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.asHours.seconds).toBe(1500);
  });

  it('returns no_range for keep_fit (no finish-time goal)', () => {
    expect(resolveFinishTime(15900, 'keep_fit')).toEqual({ status: 'no_range' });
  });
});

describe('resolveFinishTimeForMiles (R1 fix 5 — the pace envelope)', () => {
  it('accepts a sub-5 mile, which the 5k bucket band would have rejected', () => {
    expect(resolveFinishTimeForMiles(300, 1)).toEqual({ status: 'ok', seconds: 300 });
  });

  it('rejects an implausibly fast or slow time for the distance', () => {
    expect(resolveFinishTimeForMiles(30, 1)).toEqual({ status: 'out_of_range', seconds: 30 }); // 30s mile
    expect(resolveFinishTimeForMiles(2000, 1)).toEqual({ status: 'out_of_range', seconds: 2000 }); // 33min mile
  });

  it('accepts a plausible ultra finish against the real distance', () => {
    expect(resolveFinishTimeForMiles(14400, 44)).toEqual({ status: 'ok', seconds: 14400 }); // 4h for 44mi — fast but in envelope
  });

  it('carries the bucket path’s ambiguity handling (the "4:25" case)', () => {
    const r = resolveFinishTimeForMiles(265, 26.2); // 4m25s against a marathon-length envelope
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.asHours.label).toBe('4:25:00');
  });

  it('returns no_range for a nonsense distance', () => {
    expect(resolveFinishTimeForMiles(300, 0)).toEqual({ status: 'no_range' });
    expect(resolveFinishTimeForMiles(300, NaN)).toEqual({ status: 'no_range' });
  });
});

describe('isPastISODate (R1 fix 3)', () => {
  it('flags a date strictly before today', () => {
    expect(isPastISODate('2025-09-01', '2026-06-10')).toBe(true);
    expect(isPastISODate('2026-06-09', '2026-06-10')).toBe(true);
  });

  it('does not flag today or the future', () => {
    expect(isPastISODate('2026-06-10', '2026-06-10')).toBe(false);
    expect(isPastISODate('2026-09-01', '2026-06-10')).toBe(false);
  });

  it('never flags a non-ISO string (intended-branch placeholders pass through)', () => {
    expect(isPastISODate('September or later', '2026-06-10')).toBe(false);
    expect(isPastISODate('2025-09', '2026-06-10')).toBe(false);
  });
});

describe('pace ↔ finish', () => {
  it('computes the implied finish for 10 min/mi over a marathon (~4:22)', () => {
    const finish = paceToFinish(600, 'marathon'); // 600s/mi × 26.2
    expect(finish).toBe(15720);
    expect(Math.round(finish / 60)).toBe(262); // ~4h22m
  });

  it('computes the implied pace for a 4:25 marathon', () => {
    expect(finishToPace(15900, 'marathon')).toBe(607); // ~10:07/mi
  });

  it('formats a pace as M:SS/mi', () => {
    expect(formatPace(607)).toBe('10:07/mi');
    expect(formatPace(600)).toBe('10:00/mi');
  });
});
