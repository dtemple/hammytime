import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('@/lib/anthropic', () => ({ anthropicClient: () => ({ messages: { create: createMock } }) }));
vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('../memory', () => ({ upsertProfileSection: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import { upsertProfileSection } from '../memory';
import { enrichmentStep } from '../steps/04-enrichment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const msg = (text: string, partial: Record<string, unknown> = {}) =>
  enrichmentStep.handleMessage!(text, partial, 'a1');
const cb = (data: string, partial: Record<string, unknown> = {}) =>
  enrichmentStep.handleCallback!(data, partial, 'a1');

function toolResult(input: object) {
  return { content: [{ type: 'tool_use', name: 'extract_enrichment', input }] };
}

const FULL = {
  age: { value: 38, provenance: 'stated' },
  target_time_sec: { value: 14400, provenance: 'stated' },
  tuneup_races: [],
  schedule_notes: { value: 'early-morning runner', provenance: 'inferred' },
  gear_notes: { value: null, provenance: 'unknown' },
  motivation: { value: null, provenance: 'unknown' },
};

beforeEach(() => vi.clearAllMocks());

describe('enrichment — dump extraction + echo', () => {
  it('extracts and echoes stated/inferred fields with confirm buttons', async () => {
    createMock.mockResolvedValue(toolResult(FULL));

    const r = await msg('I am 38, want a sub-4, run before work');
    expect(r.done).toBe(false);
    if (!r.done) {
      expect((r.newPartial as { sub_step: string }).sub_step).toBe('confirm');
      expect(r.reply).toContain('38');
      expect(r.reply).toContain('4:00:00');
      expect(r.reply).toContain('early-morning');
      expect(r.replyMarkup).toBeDefined();
    }
  });

  it('finishes immediately when extraction yields nothing to confirm', async () => {
    createMock.mockResolvedValue(
      toolResult({
        age: { value: null, provenance: 'unknown' },
        target_time_sec: { value: null, provenance: 'unknown' },
        tuneup_races: [],
        schedule_notes: { value: null, provenance: 'unknown' },
        gear_notes: { value: null, provenance: 'unknown' },
        motivation: { value: null, provenance: 'unknown' },
      }),
    );
    const r = await msg('hmm');
    expect(r.done).toBe(true);
    if (r.done) expect(r.reply).toContain('all set');
  });
});

describe('enrichment — skip / confirm callbacks', () => {
  it('Skip completes without writing', async () => {
    const r = await cb('enrich:skip', { sub_step: 'awaiting_dump' });
    expect(r.done).toBe(true);
  });

  it('All correct completes', async () => {
    const r = await cb('enrich:correct', { sub_step: 'confirm', extracted: FULL });
    expect(r.done).toBe(true);
  });

  it('Let me fix loops back to the dump', async () => {
    const r = await cb('enrich:fix', { sub_step: 'confirm', extracted: FULL });
    expect(r.done).toBe(false);
    if (!r.done) expect((r.newPartial as { sub_step: string }).sub_step).toBe('awaiting_dump');
  });
});

describe('enrichment — onComplete provenance backfill', () => {
  it('writes a stated age to dob and tags inferred fields in memory', async () => {
    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const races = {
      select: () => ({
        eq: () => ({
          eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => ({ data: null }) }) }) }),
        }),
      }),
    };
    const db = {
      from: vi.fn().mockImplementation((t: string) =>
        t === 'athletes' ? { update: () => ({ eq: updateEq }) } : races,
      ),
    };
    (supabaseAdmin as AnyMock).mockReturnValue(db);

    await enrichmentStep.onComplete('a1', { sub_step: 'confirm', extracted: FULL });

    // dob written from stated age
    expect(updateEq).toHaveBeenCalledWith('id', 'a1');
    // memory written with provenance tags
    const memCall = (upsertProfileSection as AnyMock).mock.calls[0];
    expect(memCall[1]).toBe('Background');
    expect(memCall[2]).toContain('(stated)');
    expect(memCall[2]).toContain('(inferred)');
  });
});
