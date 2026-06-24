import { describe, it, expect } from 'vitest';
import { rotateLogByDate } from '../log-rotation';

const PREAMBLE = `# Check-in Log

_Running log._

<!-- newest at top -->`;

// Build a newest-at-top log spanning `days` distinct dates, `perDay` entries each.
function makeLog(days: number, perDay = 1): { content: string; dates: string[] } {
  const dates: string[] = [];
  const blocks: string[] = [];
  // Day 1..days mapped to 2026-06-01.. ; newest (highest date) first.
  for (let d = days; d >= 1; d--) {
    const date = `2026-06-${String(d).padStart(2, '0')}`;
    dates.push(date);
    for (let e = 0; e < perDay; e++) {
      blocks.push(
        `## ${date} — entry ${e}\n**Status:** something happened on ${date} #${e}\n\n---`,
      );
    }
  }
  return { content: PREAMBLE + '\n' + blocks.join('\n'), dates };
}

const OPTS = { keepDates: 14, triggerChars: 20_000 };

// Force the trigger regardless of size by padding the preamble with a comment.
function pad(content: string, toChars: number): string {
  if (content.length >= toChars) return content;
  return `<!-- ${'x'.repeat(toChars - content.length)} -->\n` + content;
}

describe('rotateLogByDate', () => {
  it('returns null when under triggerChars', () => {
    const { content } = makeLog(30);
    expect(content.length).toBeLessThan(OPTS.triggerChars);
    expect(rotateLogByDate(content, OPTS)).toBeNull();
  });

  it('splits an over-cap log, keeping only the most recent keepDates dates', () => {
    const { content } = makeLog(30, 2); // 30 dates, 2 entries each
    const big = pad(content, 21_000);
    const rot = rotateLogByDate(big, OPTS);
    expect(rot).not.toBeNull();

    // Recent 14 dates kept (2026-06-17..30), older 16 dates archived.
    for (let d = 17; d <= 30; d++) {
      const date = `2026-06-${String(d).padStart(2, '0')}`;
      expect(rot!.working).toContain(date);
      expect(rot!.archived).not.toContain(date);
    }
    for (let d = 1; d <= 16; d++) {
      const date = `2026-06-${String(d).padStart(2, '0')}`;
      expect(rot!.archived).toContain(date);
      expect(rot!.working).not.toContain(date);
    }
    // Preamble stays with the working slice.
    expect(rot!.working).toContain('# Check-in Log');
  });

  it('keeps every entry of a kept date and archives every entry of an old date', () => {
    const { content } = makeLog(20, 3);
    const rot = rotateLogByDate(pad(content, 21_000), OPTS);
    // 3 entries on the newest date all kept; 3 on the oldest all archived.
    expect((rot!.working.match(/## 2026-06-20 /g) ?? []).length).toBe(3);
    expect((rot!.archived.match(/## 2026-06-01 /g) ?? []).length).toBe(3);
  });

  it('reconstructs the full entry set from working + archived', () => {
    const { content } = makeLog(40);
    const rot = rotateLogByDate(pad(content, 21_000), OPTS)!;
    const all = (s: string) => (s.match(/## 2026-06-\d{2} — entry \d/g) ?? []).sort();
    expect([...all(rot.working), ...all(rot.archived)].sort()).toEqual(all(content));
  });

  it('returns null when distinct dates <= keepDates even if over triggerChars', () => {
    const { content } = makeLog(14, 5); // 14 dates, padded large
    const big = pad(content, 25_000);
    expect(big.length).toBeGreaterThan(OPTS.triggerChars);
    expect(rotateLogByDate(big, OPTS)).toBeNull();
  });

  it('returns null for a large log with no date headers (Chase format)', () => {
    const noHeaders = 'Some free-form log\n'.repeat(2000); // >20k chars, zero headers
    expect(noHeaders.length).toBeGreaterThan(OPTS.triggerChars);
    expect(rotateLogByDate(noHeaders, OPTS)).toBeNull();
  });

  it('preserves original (newest-first) order within each side', () => {
    const { content } = makeLog(20);
    const rot = rotateLogByDate(pad(content, 21_000), OPTS)!;
    const idx20 = rot.working.indexOf('2026-06-20');
    const idx07 = rot.working.indexOf('2026-06-07');
    expect(idx20).toBeGreaterThanOrEqual(0);
    expect(idx07).toBeGreaterThan(idx20); // newest appears before older
  });
});
