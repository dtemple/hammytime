import { describe, it, expect, vi } from 'vitest';

// send.ts pulls in grammy + the db client at import; neither is exercised by
// renderTelegramHtml, so stub them to keep the unit test hermetic. The corpus
// lookup (resolveExercise) is intentionally NOT mocked — these assert against
// the real worker/knowledge/exercises.md entries.
vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('grammy', () => ({ Bot: vi.fn() }));

import { renderTelegramHtml } from '../send';

describe('renderTelegramHtml', () => {
  it('escapes HTML-special characters in prose', () => {
    expect(renderTelegramHtml('keep it < 8/10 effort & relax > yesterday')).toBe(
      'keep it &lt; 8/10 effort &amp; relax &gt; yesterday',
    );
  });

  it('links a known slug token to its corpus source', () => {
    expect(renderTelegramHtml('try [single-leg calf raises](single-leg-calf-raise) tonight')).toBe(
      'try <a href="https://e3rehab.com/calves/">single-leg calf raises</a> tonight',
    );
  });

  it('collapses an unknown slug token to plain text (no link, no fabricated URL)', () => {
    expect(renderTelegramHtml('do [some move](not-a-real-slug) daily')).toBe('do some move daily');
  });

  it('escapes the visible label inside the anchor', () => {
    expect(renderTelegramHtml('[A & B](dead-bug)')).toBe(
      '<a href="https://www.youtube.com/watch?v=BZYaCzbP09M">A &amp; B</a>',
    );
  });

  it('leaves prose without tokens unchanged', () => {
    expect(renderTelegramHtml('nice work today, keep it easy')).toBe(
      'nice work today, keep it easy',
    );
  });

  it('converts **bold** to <b> tags', () => {
    expect(renderTelegramHtml('**Friday 6/5** — easy 5')).toBe('<b>Friday 6/5</b> — easy 5');
  });

  it('nests a bolded link as <b><a>', () => {
    expect(renderTelegramHtml('**[single-leg calf raises](single-leg-calf-raise)**')).toBe(
      '<b><a href="https://e3rehab.com/calves/">single-leg calf raises</a></b>',
    );
  });

  it('leaves single asterisks and snake_case filenames alone', () => {
    expect(renderTelegramHtml('noted in race_calendar.md and *keep* easy')).toBe(
      'noted in race_calendar.md and *keep* easy',
    );
  });
});
