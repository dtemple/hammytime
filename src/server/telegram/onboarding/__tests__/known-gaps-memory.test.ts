import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));

import { supabaseAdmin } from '@/lib/db';
import {
  renderKnownGaps,
  renderKnownGapsFromFilled,
  parseKnownGaps,
  seedKnownGaps,
  KNOWN_GAPS_FILE,
} from '../known-gaps-memory';
import type { Extracted } from '../steps/05-enrichment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const prov = (value: unknown, provenance: string) => ({ value, provenance }) as never;

function extraction(overrides: Partial<Extracted> = {}): Extracted {
  return {
    age: prov(null, 'unknown'),
    target_time_sec: prov(null, 'unknown'),
    tuneup_races: [],
    schedule_notes: prov(null, 'unknown'),
    gear_notes: prov(null, 'unknown'),
    motivation: prov(null, 'unknown'),
    ...overrides,
  } as Extracted;
}

const TODAY = '2026-06-03';

describe('renderKnownGaps', () => {
  it('opens all six gaps when nothing was captured (skip path)', () => {
    const md = renderKnownGaps(null, TODAY);
    for (const key of [
      'strength_equipment',
      'target_time',
      'tune_up_races',
      'schedule_constraints',
      'age',
      'recent_long_run',
    ]) {
      expect(md).toContain(`[open] ${key}:`);
    }
    expect(md).not.toContain(`[filled ${TODAY}]`);
    // strength_equipment surfaces its discrete options for the coach
    expect(md).toContain('(gym / free_weights / bodyweight_only / unsure)');
  });

  it('marks stated fields filled with value + date, leaves the rest open', () => {
    const md = renderKnownGaps(
      extraction({
        age: prov(38, 'stated'),
        target_time_sec: prov(14400, 'stated'),
        tuneup_races: [
          { name: 'Berkeley Half', date: '2026-10-18', provenance: 'stated' },
        ] as never,
        schedule_notes: prov('early mornings', 'stated'),
      }),
      TODAY,
    );

    expect(md).toContain(`[filled ${TODAY}] age: 38`);
    expect(md).toContain(`[filled ${TODAY}] target_time: 4:00:00`);
    expect(md).toContain(`[filled ${TODAY}] tune_up_races: Berkeley Half (2026-10-18)`);
    expect(md).toContain(`[filled ${TODAY}] schedule_constraints: early mornings`);
    // never captured during onboarding → still open
    expect(md).toContain('[open] strength_equipment:');
    expect(md).toContain('[open] recent_long_run:');
  });

  it('keeps inferred / unknown fields open (only stated gets filled)', () => {
    const md = renderKnownGaps(
      extraction({
        age: prov(40, 'inferred'),
        schedule_notes: prov('runs before work', 'inferred'),
      }),
      TODAY,
    );
    expect(md).toContain('[open] age:');
    expect(md).toContain('[open] schedule_constraints:');
    expect(md).not.toContain(`[filled ${TODAY}]`);
  });
});

describe('seedKnownGaps', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts known_gaps.md keyed on (athlete_id, file_name)', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    (supabaseAdmin as AnyMock).mockReturnValue({ from: vi.fn().mockReturnValue({ upsert }) });

    await seedKnownGaps('a1', null);

    const [row, opts] = upsert.mock.calls[0]!;
    expect(row.athlete_id).toBe('a1');
    expect(row.file_name).toBe(KNOWN_GAPS_FILE);
    expect(row.content_md).toContain('# Known gaps');
    expect(opts).toEqual({ onConflict: 'athlete_id,file_name' });
  });

  it('throws when the upsert fails', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: { message: 'boom' } });
    (supabaseAdmin as AnyMock).mockReturnValue({ from: vi.fn().mockReturnValue({ upsert }) });
    await expect(seedKnownGaps('a1', null)).rejects.toThrow('seedKnownGaps failed: boom');
  });
});

describe('parseKnownGaps', () => {
  it('extracts open gap keys in file order (the inverse of the renderer)', () => {
    const md = renderKnownGapsFromFilled({}, TODAY); // everything open
    const { open, filled } = parseKnownGaps(md);
    // GAP_ORDER: strength_equipment, target_time, tune_up_races, schedule_constraints, age, recent_long_run
    expect(open).toEqual([
      'strength_equipment',
      'target_time',
      'tune_up_races',
      'schedule_constraints',
      'age',
      'recent_long_run',
    ]);
    expect(filled).toEqual({});
  });

  it('separates filled gaps from open ones and recovers their values', () => {
    const md = renderKnownGapsFromFilled({ age: '42', strength_equipment: 'gym' }, TODAY);
    const { open, filled } = parseKnownGaps(md);
    expect(filled).toEqual({ age: '42', strength_equipment: 'gym' });
    expect(open).not.toContain('age');
    expect(open).not.toContain('strength_equipment');
    expect(open).toContain('target_time');
  });

  it('round-trips: render → parse → re-render is stable', () => {
    const filledIn = { target_time: '3:45:00', schedule_constraints: 'no Mondays' };
    const md1 = renderKnownGapsFromFilled(filledIn, TODAY);
    const { filled } = parseKnownGaps(md1);
    expect(renderKnownGapsFromFilled(filled, TODAY)).toBe(md1);
  });

  it('ignores non-gap lines and bogus keys', () => {
    const md = ['# Known gaps', '', '- [open] not_a_real_gap: junk', 'random text'].join('\n');
    expect(parseKnownGaps(md)).toEqual({ open: [], filled: {} });
  });
});
