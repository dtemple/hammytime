import { describe, it, expect } from 'vitest';
import { basicsStep } from '../steps/00-basics';

const nameQ = basicsStep.questions[0]!;
const ageQ = basicsStep.questions[1]!;
const sexQ = basicsStep.questions[2]!;
const tzQ = basicsStep.questions[3]!;
const daysQ = basicsStep.questions[4]!;
const hoursQ = basicsStep.questions[5]!;

const partial = {};

describe('name question', () => {
  it('accepts a normal name', () => {
    expect(nameQ.parseReply('David', partial)).toEqual({ ok: true, value: 'David' });
  });

  it('trims whitespace', () => {
    expect(nameQ.parseReply('  Alice  ', partial)).toEqual({ ok: true, value: 'Alice' });
  });

  it('rejects empty string', () => {
    const r = nameQ.parseReply('', partial);
    expect(r.ok).toBe(false);
  });

  it('rejects a 61-character string', () => {
    const r = nameQ.parseReply('A'.repeat(61), partial);
    expect(r.ok).toBe(false);
  });

  it('accepts exactly 60 characters', () => {
    const r = nameQ.parseReply('A'.repeat(60), partial);
    expect(r.ok).toBe(true);
  });
});

describe('age question', () => {
  it('accepts 35', () => {
    expect(ageQ.parseReply('35', partial)).toEqual({ ok: true, value: 35 });
  });

  it('rejects 12 (under minimum)', () => {
    expect(ageQ.parseReply('12', partial).ok).toBe(false);
  });

  it('rejects 101 (over maximum)', () => {
    expect(ageQ.parseReply('101', partial).ok).toBe(false);
  });

  it('accepts boundary: 13 and 100', () => {
    expect(ageQ.parseReply('13', partial)).toEqual({ ok: true, value: 13 });
    expect(ageQ.parseReply('100', partial)).toEqual({ ok: true, value: 100 });
  });

  it('rejects non-numeric', () => {
    expect(ageQ.parseReply('abc', partial).ok).toBe(false);
    expect(ageQ.parseReply('3five', partial).ok).toBe(false);
  });
});

describe('sex question', () => {
  it('maps m / male → M', () => {
    expect(sexQ.parseReply('m', partial)).toEqual({ ok: true, value: 'M' });
    expect(sexQ.parseReply('male', partial)).toEqual({ ok: true, value: 'M' });
    expect(sexQ.parseReply('Male', partial)).toEqual({ ok: true, value: 'M' });
  });

  it('maps f / female → F', () => {
    expect(sexQ.parseReply('f', partial)).toEqual({ ok: true, value: 'F' });
    expect(sexQ.parseReply('female', partial)).toEqual({ ok: true, value: 'F' });
    expect(sexQ.parseReply('Female', partial)).toEqual({ ok: true, value: 'F' });
  });

  it('maps anything else → other', () => {
    expect(sexQ.parseReply('non-binary', partial)).toEqual({ ok: true, value: 'other' });
    expect(sexQ.parseReply('prefer not to say', partial)).toEqual({ ok: true, value: 'other' });
    expect(sexQ.parseReply('other', partial)).toEqual({ ok: true, value: 'other' });
  });
});

describe('timezone question', () => {
  it('accepts PST and maps to America/Los_Angeles', () => {
    expect(tzQ.parseReply('PST', partial)).toEqual({ ok: true, value: 'America/Los_Angeles' });
  });

  it('accepts EST → America/New_York', () => {
    expect(tzQ.parseReply('EST', partial)).toEqual({ ok: true, value: 'America/New_York' });
  });

  it('accepts MST → America/Denver', () => {
    expect(tzQ.parseReply('MST', partial)).toEqual({ ok: true, value: 'America/Denver' });
  });

  it('accepts CST → America/Chicago', () => {
    expect(tzQ.parseReply('CST', partial)).toEqual({ ok: true, value: 'America/Chicago' });
  });

  it('accepts New York (case-insensitive city name)', () => {
    expect(tzQ.parseReply('New York', partial)).toEqual({ ok: true, value: 'America/New_York' });
  });

  it('accepts nyc', () => {
    expect(tzQ.parseReply('nyc', partial)).toEqual({ ok: true, value: 'America/New_York' });
  });

  it('accepts a direct IANA identifier', () => {
    expect(tzQ.parseReply('America/Chicago', partial)).toEqual({
      ok: true,
      value: 'America/Chicago',
    });
  });

  it('accepts Europe/London as a valid IANA timezone', () => {
    expect(tzQ.parseReply('Europe/London', partial).ok).toBe(true);
  });

  it('rejects a nonsense string', () => {
    expect(tzQ.parseReply('Narnia', partial).ok).toBe(false);
  });
});

describe('days_per_week question', () => {
  it('accepts 5', () => {
    expect(daysQ.parseReply('5', partial)).toEqual({ ok: true, value: 5 });
  });

  it('accepts boundaries: 3 and 7', () => {
    expect(daysQ.parseReply('3', partial)).toEqual({ ok: true, value: 3 });
    expect(daysQ.parseReply('7', partial)).toEqual({ ok: true, value: 7 });
  });

  it('rejects 2 (too low)', () => {
    expect(daysQ.parseReply('2', partial).ok).toBe(false);
  });

  it('rejects 8 (too high)', () => {
    expect(daysQ.parseReply('8', partial).ok).toBe(false);
  });

  it('rejects word form', () => {
    expect(daysQ.parseReply('five', partial).ok).toBe(false);
  });
});

describe('hours_per_week question', () => {
  it('accepts 10', () => {
    expect(hoursQ.parseReply('10', partial)).toEqual({ ok: true, value: 10 });
  });

  it('accepts boundaries: 3 and 20', () => {
    expect(hoursQ.parseReply('3', partial)).toEqual({ ok: true, value: 3 });
    expect(hoursQ.parseReply('20', partial)).toEqual({ ok: true, value: 20 });
  });

  it('rejects 2 (too low)', () => {
    expect(hoursQ.parseReply('2', partial).ok).toBe(false);
  });

  it('rejects 25 (too high)', () => {
    expect(hoursQ.parseReply('25', partial).ok).toBe(false);
  });
});
