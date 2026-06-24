import { describe, it, expect } from 'vitest';

// pause.ts imports telegramBot from ./bot and supabaseAdmin from @/lib/db at the
// top level; isInactive uses neither, so stub both to keep this a pure unit test.
import { vi } from 'vitest';
vi.mock('../bot', () => ({ telegramBot: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));

import { isInactive, daysUntilAutoPause, INACTIVITY_WINDOW_DAYS } from '../pause';

const NOW = Date.parse('2026-06-14T12:00:00.000Z');
const cutoffMs = NOW - INACTIVITY_WINDOW_DAYS * 86_400_000;

function athlete(id: string, createdAtMs: number) {
  return { id, created_at: new Date(createdAtMs).toISOString() };
}

describe('isInactive', () => {
  it('keeps an athlete with inbound inside the window active', () => {
    const a = athlete('a1', NOW - 30 * 86_400_000); // created long ago…
    expect(isInactive(a, new Set(['a1']), cutoffMs)).toBe(false); // …but recently active
  });

  it('pauses an athlete created before the window with no recent inbound', () => {
    const a = athlete('a2', NOW - 30 * 86_400_000);
    expect(isInactive(a, new Set(), cutoffMs)).toBe(true);
  });

  it('does not pause a freshly-onboarded athlete with no inbound yet (created_at floor)', () => {
    const a = athlete('a3', NOW - 3 * 86_400_000); // created 3 days ago, never chatted
    expect(isInactive(a, new Set(), cutoffMs)).toBe(false);
  });

  it('treats activity as winning even when created before the window', () => {
    const a = athlete('a4', NOW - 90 * 86_400_000);
    expect(isInactive(a, new Set(['a4']), cutoffMs)).toBe(false);
  });

  it('pauses exactly at the boundary (created before cutoff, silent)', () => {
    const a = athlete('a5', cutoffMs - 1);
    expect(isInactive(a, new Set(), cutoffMs)).toBe(true);
  });

  it('keeps an athlete created exactly at the cutoff active', () => {
    const a = athlete('a6', cutoffMs);
    expect(isInactive(a, new Set(), cutoffMs)).toBe(false);
  });
});

describe('daysUntilAutoPause', () => {
  const created = NOW - 90 * 86_400_000; // long ago, so last-inbound is the driver

  it('returns the full window for an athlete who just messaged', () => {
    expect(
      daysUntilAutoPause({ created_at: new Date(created).toISOString() }, NOW, NOW),
    ).toBeCloseTo(INACTIVITY_WINDOW_DAYS);
  });

  it('counts down from the last inbound', () => {
    const twoDaysAgo = NOW - 2 * 86_400_000;
    expect(
      daysUntilAutoPause({ created_at: new Date(created).toISOString() }, twoDaysAgo, NOW),
    ).toBeCloseTo(INACTIVITY_WINDOW_DAYS - 2);
  });

  it('falls back to the created_at floor when there is no inbound in the window', () => {
    const createdTwoDaysAgo = NOW - 2 * 86_400_000;
    expect(
      daysUntilAutoPause({ created_at: new Date(createdTwoDaysAgo).toISOString() }, null, NOW),
    ).toBeCloseTo(INACTIVITY_WINDOW_DAYS - 2);
  });

  it('goes non-positive once an athlete is past due', () => {
    const createdSixDaysAgo = NOW - 6 * 86_400_000;
    expect(
      daysUntilAutoPause({ created_at: new Date(createdSixDaysAgo).toISOString() }, null, NOW),
    ).toBeLessThanOrEqual(0);
  });

  it('lets a recent inbound win over an old creation date', () => {
    const justNow = NOW - 60 * 60 * 1000; // an hour ago
    expect(
      daysUntilAutoPause({ created_at: new Date(created).toISOString() }, justNow, NOW),
    ).toBeGreaterThan(INACTIVITY_WINDOW_DAYS - 1);
  });
});
