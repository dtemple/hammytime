import { describe, it, expect } from 'vitest';
import { resolveFinishTime, paceToFinish, finishToPace, formatPace } from '../numeric';

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
