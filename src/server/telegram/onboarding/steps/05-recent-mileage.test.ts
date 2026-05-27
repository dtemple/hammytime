import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/telegram/onboarding/memory', () => ({
  upsertProfileSection: vi.fn().mockResolvedValue(undefined),
}));

import { supabaseAdmin } from '@/lib/db';
import { recentMileageStep } from './05-recent-mileage';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// recent_avg_mi_per_week parseReply
// ---------------------------------------------------------------------------

describe('recentMileageStep questions[0] (recent_avg_mi_per_week)', () => {
  const q = recentMileageStep.questions[0]!;

  it('accepts a valid mileage', () => {
    expect(q.parseReply('35', {})).toEqual({ ok: true, value: 35 });
  });

  it('accepts 0', () => {
    expect(q.parseReply('0', {})).toEqual({ ok: true, value: 0 });
  });

  it('accepts 120', () => {
    expect(q.parseReply('120', {})).toEqual({ ok: true, value: 120 });
  });

  it('rejects a non-number', () => {
    const r = q.parseReply('abc', {});
    expect(r.ok).toBe(false);
  });

  it('rejects 121 (out of range)', () => {
    const r = q.parseReply('121', {});
    expect(r.ok).toBe(false);
  });

  it('rejects negative', () => {
    const r = q.parseReply('-1', {});
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// longest_recent_mi parseReply
// ---------------------------------------------------------------------------

describe('recentMileageStep questions[1] (longest_recent_mi)', () => {
  const q = recentMileageStep.questions[1]!;

  it('accepts a valid distance', () => {
    expect(q.parseReply('20', {})).toEqual({ ok: true, value: 20 });
  });

  it('accepts 0', () => {
    expect(q.parseReply('0', {})).toEqual({ ok: true, value: 0 });
  });

  it('accepts 60', () => {
    expect(q.parseReply('60', {})).toEqual({ ok: true, value: 60 });
  });

  it('rejects 61 (out of range)', () => {
    const r = q.parseReply('61', {});
    expect(r.ok).toBe(false);
  });

  it('rejects a non-number', () => {
    const r = q.parseReply('marathon', {});
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// onComplete — sanity warn
// ---------------------------------------------------------------------------

describe('recentMileageStep.onComplete sanity warn', () => {
  function makeDb(notesValue: string | null = '') {
    const singleFn = vi.fn().mockResolvedValue({ data: { notes: notesValue }, error: null });
    const eqSelectChain = { eq: vi.fn().mockReturnThis(), single: singleFn };
    eqSelectChain.eq.mockReturnValue(eqSelectChain);

    const eqUpdateFn = vi.fn().mockResolvedValue({ error: null });
    const updateFn = vi.fn().mockReturnValue({ eq: eqUpdateFn });

    const fromFn = vi.fn().mockImplementation((table: string) => {
      if (table === 'athletes') {
        return {
          select: vi.fn().mockReturnValue(eqSelectChain),
          update: updateFn,
        };
      }
      return {};
    });
    return { from: fromFn };
  }

  it('emits console.warn when longest > 2× avg', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb('Goal distance: Marathon'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await recentMileageStep.onComplete('athlete-1', {
      recent_avg_mi_per_week: 20,
      longest_recent_mi: 50,
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unusual but accepted'));
    warnSpy.mockRestore();
  });

  it('does NOT emit console.warn for a normal ratio', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb('Goal distance: Marathon'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await recentMileageStep.onComplete('athlete-1', {
      recent_avg_mi_per_week: 35,
      longest_recent_mi: 20,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
