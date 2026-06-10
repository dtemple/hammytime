import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));

import { loadPrehabPageData } from './page-data';
import { supabaseAdmin } from '@/lib/db';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

type LinkRow = { athlete_id: string | null; expires_at: string | null } | null;
type FileRow = { content_md: string; updated_at: string } | null;

function makeDb(opts: { link: LinkRow; athleteName?: string | null; file?: FileRow }) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'link_tokens') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: () => ({ data: opts.link, error: null }) }),
            }),
          }),
        };
      }
      if (table === 'athletes') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => ({
                data: opts.athleteName != null ? { name: opts.athleteName } : null,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'memory_files') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: () => ({ data: opts.file ?? null, error: null }) }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
}

describe('loadPrehabPageData', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for an unknown token', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(makeDb({ link: null }));
    expect(await loadPrehabPageData('nope')).toBeNull();
  });

  it('returns null for an expired token', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({ link: { athlete_id: 'a1', expires_at: '2020-01-01' }, athleteName: 'Sam' }),
    );
    expect(await loadPrehabPageData('old')).toBeNull();
  });

  it('returns name + content + updatedAt for a valid token with a program file', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({
        link: { athlete_id: 'a1', expires_at: '2099-01-01' },
        athleteName: 'Sam Runner',
        file: { content_md: '# Prehab routine — Sam', updated_at: '2026-06-09T12:00:00Z' },
      }),
    );
    expect(await loadPrehabPageData('tok')).toEqual({
      athleteName: 'Sam Runner',
      contentMd: '# Prehab routine — Sam',
      updatedAt: '2026-06-09T12:00:00Z',
    });
  });

  it('returns contentMd null when the program file has not been authored', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({ link: { athlete_id: 'a1', expires_at: '2099-01-01' }, athleteName: 'Sam' }),
    );
    expect(await loadPrehabPageData('tok')).toEqual({
      athleteName: 'Sam',
      contentMd: null,
      updatedAt: null,
    });
  });

  it('returns null when the athlete row is missing', async () => {
    (supabaseAdmin as AnyMock).mockReturnValue(
      makeDb({ link: { athlete_id: 'a1', expires_at: '2099-01-01' }, athleteName: null }),
    );
    expect(await loadPrehabPageData('tok')).toBeNull();
  });
});
