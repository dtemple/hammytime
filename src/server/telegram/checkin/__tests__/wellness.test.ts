import { describe, it, expect } from 'vitest';
import { parseReadiness, parseSoreness, parseNote, isConcerning } from '../wellness';

// ---------------------------------------------------------------------------
// parseReadiness
// ---------------------------------------------------------------------------
describe('parseReadiness', () => {
  it('accepts boundary 1', () => {
    expect(parseReadiness('1')).toEqual({ ok: true, value: 1 });
  });

  it('accepts boundary 10', () => {
    expect(parseReadiness('10')).toEqual({ ok: true, value: 10 });
  });

  it('accepts mid-range with surrounding whitespace', () => {
    expect(parseReadiness('  7  ')).toEqual({ ok: true, value: 7 });
  });

  it('rejects 0', () => {
    const r = parseReadiness('0');
    expect(r.ok).toBe(false);
  });

  it('rejects 11', () => {
    const r = parseReadiness('11');
    expect(r.ok).toBe(false);
  });

  it("rejects word 'ten'", () => {
    const r = parseReadiness('ten');
    expect(r.ok).toBe(false);
  });

  it('rejects decimal', () => {
    const r = parseReadiness('7.5');
    expect(r.ok).toBe(false);
  });

  it('rejects empty string', () => {
    const r = parseReadiness('');
    expect(r.ok).toBe(false);
  });

  it('rejects text with a valid number embedded', () => {
    const r = parseReadiness('feel 7');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseSoreness
// ---------------------------------------------------------------------------
describe('parseSoreness', () => {
  it('accepts score only', () => {
    const r = parseSoreness('3');
    expect(r).toEqual({ ok: true, value: { score: 3, body_part: null } });
  });

  it('accepts score + body part', () => {
    const r = parseSoreness('7 left hamstring');
    expect(r).toEqual({
      ok: true,
      value: { score: 7, body_part: 'left hamstring' },
    });
  });

  it('accepts score + body part with leading dash notation', () => {
    const r = parseSoreness('7 — left hamstring');
    expect(r).toEqual({
      ok: true,
      value: { score: 7, body_part: 'left hamstring' },
    });
  });

  it('accepts boundary scores 1 and 10', () => {
    expect(parseSoreness('1')).toEqual({ ok: true, value: { score: 1, body_part: null } });
    expect(parseSoreness('10')).toEqual({ ok: true, value: { score: 10, body_part: null } });
  });

  it('accepts multi-word body part', () => {
    const r = parseSoreness('5 bilateral hamstrings');
    expect(r).toEqual({
      ok: true,
      value: { score: 5, body_part: 'bilateral hamstrings' },
    });
  });

  it('rejects score 0', () => {
    expect(parseSoreness('0').ok).toBe(false);
  });

  it('rejects score 11', () => {
    expect(parseSoreness('11').ok).toBe(false);
  });

  it('rejects no leading number', () => {
    expect(parseSoreness('left hamstring').ok).toBe(false);
  });

  it('rejects empty string', () => {
    expect(parseSoreness('').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseNote
// ---------------------------------------------------------------------------
describe('parseNote', () => {
  it("returns null for 'skip'", () => {
    expect(parseNote('skip')).toEqual({ ok: true, value: null });
  });

  it("returns null for 'SKIP' (case-insensitive)", () => {
    expect(parseNote('SKIP')).toEqual({ ok: true, value: null });
  });

  it("returns null for 'none'", () => {
    expect(parseNote('none')).toEqual({ ok: true, value: null });
  });

  it("returns null for em-dash '—'", () => {
    expect(parseNote('—')).toEqual({ ok: true, value: null });
  });

  it('returns null for empty string', () => {
    expect(parseNote('')).toEqual({ ok: true, value: null });
  });

  it('returns null for whitespace only', () => {
    expect(parseNote('   ')).toEqual({ ok: true, value: null });
  });

  it('returns trimmed text for real input', () => {
    expect(parseNote("  felt good on yesterday's run  ")).toEqual({
      ok: true,
      value: "felt good on yesterday's run",
    });
  });

  it('caps at 500 characters', () => {
    const long = 'a'.repeat(600);
    const r = parseNote(long);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value?.length).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// isConcerning
// ---------------------------------------------------------------------------
describe('isConcerning', () => {
  it('flags readiness <= 4', () => {
    expect(isConcerning(4, 3, null)).toBe(true);
    expect(isConcerning(1, 3, null)).toBe(true);
  });

  it('does not flag readiness 5', () => {
    expect(isConcerning(5, 3, null)).toBe(false);
  });

  it('flags soreness >= 6 with body part', () => {
    expect(isConcerning(7, 6, 'left knee')).toBe(true);
    expect(isConcerning(7, 9, 'hamstring')).toBe(true);
  });

  it('does not flag soreness 5 with body part', () => {
    expect(isConcerning(7, 5, 'left knee')).toBe(false);
  });

  it('flags soreness >= 7 without body part', () => {
    expect(isConcerning(7, 7, null)).toBe(true);
    expect(isConcerning(7, 10, null)).toBe(true);
  });

  it('does not flag soreness 6 without body part', () => {
    expect(isConcerning(7, 6, null)).toBe(false);
  });

  it('does not flag normal values', () => {
    expect(isConcerning(7, 3, null)).toBe(false);
    expect(isConcerning(8, 4, 'knee')).toBe(false);
  });
});
