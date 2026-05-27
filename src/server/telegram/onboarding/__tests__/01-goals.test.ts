import { describe, it, expect } from 'vitest';
import { goalsStep, parseTargetTime } from '../steps/01-goals';

const distanceQ = goalsStep.questions[0]!;
const targetQ = goalsStep.questions[1]!;
const targetTimeQ = goalsStep.questions[2]!;
const meaningQ = goalsStep.questions[3]!;

const partial = {};

describe('distance question', () => {
  it('accepts 5k variants', () => {
    expect(distanceQ.parseReply('5k', partial)).toEqual({ ok: true, value: '5k' });
    expect(distanceQ.parseReply('5K', partial)).toEqual({ ok: true, value: '5k' });
    expect(distanceQ.parseReply('5km', partial)).toEqual({ ok: true, value: '5k' });
  });

  it('accepts 10k variants', () => {
    expect(distanceQ.parseReply('10k', partial)).toEqual({ ok: true, value: '10k' });
    expect(distanceQ.parseReply('10K', partial)).toEqual({ ok: true, value: '10k' });
  });

  it('accepts half marathon variants', () => {
    expect(distanceQ.parseReply('half', partial)).toEqual({ ok: true, value: 'half' });
    expect(distanceQ.parseReply('half marathon', partial)).toEqual({ ok: true, value: 'half' });
    expect(distanceQ.parseReply('HM', partial)).toEqual({ ok: true, value: 'half' });
    expect(distanceQ.parseReply('13.1', partial)).toEqual({ ok: true, value: 'half' });
  });

  it('accepts marathon variants', () => {
    expect(distanceQ.parseReply('marathon', partial)).toEqual({ ok: true, value: 'marathon' });
    expect(distanceQ.parseReply('full', partial)).toEqual({ ok: true, value: 'marathon' });
    expect(distanceQ.parseReply('full marathon', partial)).toEqual({ ok: true, value: 'marathon' });
    expect(distanceQ.parseReply('26.2', partial)).toEqual({ ok: true, value: 'marathon' });
  });

  it('accepts ultra variants', () => {
    expect(distanceQ.parseReply('ultra', partial)).toEqual({ ok: true, value: 'ultra' });
    expect(distanceQ.parseReply('ultramarathon', partial)).toEqual({ ok: true, value: 'ultra' });
    expect(distanceQ.parseReply('50k', partial)).toEqual({ ok: true, value: 'ultra' });
  });

  it('rejects unrecognised distances', () => {
    expect(distanceQ.parseReply('100 miler', partial).ok).toBe(false);
    expect(distanceQ.parseReply('triathlon', partial).ok).toBe(false);
    expect(distanceQ.parseReply('', partial).ok).toBe(false);
  });
});

describe('target question', () => {
  it('accepts time-goal variants', () => {
    expect(targetQ.parseReply('time', partial)).toEqual({ ok: true, value: 'time' });
    expect(targetQ.parseReply('for a PR', partial)).toEqual({ ok: true, value: 'time' });
    expect(targetQ.parseReply('goal time', partial)).toEqual({ ok: true, value: 'time' });
  });

  it('accepts finish variants', () => {
    expect(targetQ.parseReply('just finish', partial)).toEqual({ ok: true, value: 'finish' });
    expect(targetQ.parseReply('finish', partial)).toEqual({ ok: true, value: 'finish' });
    expect(targetQ.parseReply('complete', partial)).toEqual({ ok: true, value: 'finish' });
  });

  it('rejects empty string', () => {
    expect(targetQ.parseReply('', partial).ok).toBe(false);
  });

  it('rejects unrelated answer', () => {
    expect(targetQ.parseReply('Boston', partial).ok).toBe(false);
  });
});

describe('target_time question', () => {
  it('is skipped when target is finish', () => {
    expect(targetTimeQ.skip?.({ target: 'finish' })).toBe(true);
  });

  it('is not skipped when target is time', () => {
    expect(targetTimeQ.skip?.({ target: 'time' })).toBe(false);
  });

  it('accepts HH:MM:SS format', () => {
    expect(parseTargetTime('3:45:00')).toEqual({ ok: true, value: 13500 });
  });

  it('accepts H:MM:SS with single-digit hours', () => {
    expect(parseTargetTime('4:00:00')).toEqual({ ok: true, value: 14400 });
  });

  it('accepts MM:SS above the 10-minute minimum', () => {
    // 45:30 = 45*60 + 30 = 2730s
    expect(parseTargetTime('45:30')).toEqual({ ok: true, value: 2730 });
  });

  it('rejects MM:SS below the 10-minute minimum', () => {
    // 1:00 as MM:SS = 60s — below 600s minimum
    expect(parseTargetTime('1:00').ok).toBe(false);
  });

  it('rejects zero', () => {
    expect(parseTargetTime('0:00:00').ok).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(parseTargetTime('abc').ok).toBe(false);
    expect(parseTargetTime('3h45m').ok).toBe(false);
  });

  it('rejects invalid seconds (≥60)', () => {
    expect(parseTargetTime('3:45:60').ok).toBe(false);
  });

  it('rejects over 24 hours', () => {
    expect(parseTargetTime('25:00:00').ok).toBe(false);
  });
});

describe('meaning question', () => {
  it('accepts a short sentence', () => {
    expect(meaningQ.parseReply('This is my first marathon.', partial)).toEqual({
      ok: true,
      value: 'This is my first marathon.',
    });
  });

  it('accepts exactly 500 characters', () => {
    expect(meaningQ.parseReply('A'.repeat(500), partial).ok).toBe(true);
  });

  it('rejects 501 characters', () => {
    expect(meaningQ.parseReply('A'.repeat(501), partial).ok).toBe(false);
  });

  it('rejects empty string', () => {
    expect(meaningQ.parseReply('', partial).ok).toBe(false);
  });

  it('trims and accepts a padded valid answer', () => {
    expect(meaningQ.parseReply('  Boston  ', partial)).toEqual({
      ok: true,
      value: 'Boston',
    });
  });
});
