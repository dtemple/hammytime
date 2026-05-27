import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/telegram/onboarding/memory', () => ({
  upsertMemorySection: vi.fn(),
  upsertProfileSection: vi.fn(),
}));

import { supabaseAdmin } from '@/lib/db';
import { upsertMemorySection, upsertProfileSection } from '@/server/telegram/onboarding/memory';
import { injuriesStep } from '../steps/03-injuries';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const ATHLETE_ID = 'test-athlete';
const handleMessage = injuriesStep.handleMessage!;
const handleCallback = injuriesStep.handleCallback!;

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

function makeDb() {
  const insertMock = vi.fn().mockResolvedValue({ error: null });
  const upsertMock = vi.fn().mockResolvedValue({ error: null });
  return {
    from: vi.fn().mockReturnValue({ insert: insertMock, upsert: upsertMock }),
    insertMock,
    upsertMock,
  };
}

// ---------------------------------------------------------------------------
// Partial builders
// ---------------------------------------------------------------------------

function selectingPartial(selected: string[] = []): Record<string, unknown> {
  return {
    sub_step: 'selecting',
    selected,
    completed_count: 0,
    injuries: [],
  };
}

function detailPartial(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub_step: 'awaiting_severity',
    selected: ['back'],
    completed_count: 0,
    injuries: [],
    current_detail: {
      body_part: 'back',
      display_name: 'back',
      laterality: null,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleCallback — toggle logic
// ---------------------------------------------------------------------------

describe('handleCallback — toggle', () => {
  it('toggles a part on when not selected', async () => {
    const partial = selectingPartial([]);
    const result = await handleCallback('injury:toggle:knee', partial, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect((result.newPartial as AnyMock).selected).toEqual(['knee']);
    expect((result as AnyMock).replyMarkup).toBeDefined();
  });

  it('toggles a part off when already selected', async () => {
    const partial = selectingPartial(['knee', 'hamstring']);
    const result = await handleCallback('injury:toggle:knee', partial, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect((result.newPartial as AnyMock).selected).toEqual(['hamstring']);
  });

  it('accumulates multiple selections in order', async () => {
    let partial = selectingPartial([]);
    partial = (await handleCallback('injury:toggle:hamstring', partial, ATHLETE_ID)).newPartial;
    partial = (await handleCallback('injury:toggle:knee', partial, ATHLETE_ID)).newPartial;
    partial = (await handleCallback('injury:toggle:back', partial, ATHLETE_ID)).newPartial;
    expect((partial as AnyMock).selected).toEqual(['hamstring', 'knee', 'back']);
  });

  it('ignores unknown part names', async () => {
    const partial = selectingPartial([]);
    const result = await handleCallback('injury:toggle:elbow', partial, ATHLETE_ID);
    expect((result.newPartial as AnyMock).selected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// handleCallback — injury:none
// ---------------------------------------------------------------------------

describe('handleCallback — injury:none', () => {
  it('completes immediately with empty injuries array and a reply', async () => {
    const partial = selectingPartial(['knee']);
    const result = await handleCallback('injury:none', partial, ATHLETE_ID);
    expect(result.done).toBe(true);
    expect((result.newPartial as AnyMock).injuries).toEqual([]);
    expect((result.newPartial as AnyMock).selected).toEqual([]);
    expect((result as AnyMock).reply).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// handleCallback — injury:done
// ---------------------------------------------------------------------------

describe('handleCallback — injury:done', () => {
  it('returns alertText when nothing selected', async () => {
    const partial = selectingPartial([]);
    const result = await handleCallback('injury:done', partial, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect((result as AnyMock).alertText).toBeTruthy();
    expect(result.newPartial).toEqual(partial);
  });

  it("transitions to awaiting_other_label when 'other' is in selection", async () => {
    const partial = selectingPartial(['other']);
    const result = await handleCallback('injury:done', partial, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect((result.newPartial as AnyMock).sub_step).toBe('awaiting_other_label');
    expect((result as AnyMock).reply).toMatch(/other/i);
  });

  it('enters per-part loop for a bilateral part (hamstring → awaiting_laterality)', async () => {
    const partial = selectingPartial(['hamstring']);
    const result = await handleCallback('injury:done', partial, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect((result.newPartial as AnyMock).sub_step).toBe('awaiting_laterality');
    expect((result as AnyMock).reply).toMatch(/left, right, or both/i);
  });

  it('enters per-part loop for non-bilateral part (back → awaiting_severity)', async () => {
    const partial = selectingPartial(['back']);
    const result = await handleCallback('injury:done', partial, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect((result.newPartial as AnyMock).sub_step).toBe('awaiting_severity');
    expect((result as AnyMock).reply).toMatch(/severity/i);
  });

  it('ignores callback data when not in selecting sub_step', async () => {
    const partial = {
      ...selectingPartial(['knee']),
      sub_step: 'awaiting_severity',
    };
    const result = await handleCallback('injury:done', partial, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect(result.newPartial).toEqual(partial);
  });
});

// ---------------------------------------------------------------------------
// handleMessage — other label
// ---------------------------------------------------------------------------

describe('handleMessage — awaiting_other_label', () => {
  it('stores label and enters per-part loop', async () => {
    const partial = {
      sub_step: 'awaiting_other_label',
      selected: ['other'],
      completed_count: 0,
      injuries: [],
    };
    const result = await handleMessage('foot pain', partial, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect((result.newPartial as AnyMock).other_label).toBe('foot pain');
    // 'other' is bilateral — should ask laterality
    expect((result.newPartial as AnyMock).sub_step).toBe('awaiting_laterality');
    expect((result.newPartial as AnyMock).current_detail.display_name).toBe('foot pain');
  });

  it("falls back to 'other' when label is blank", async () => {
    const partial = {
      sub_step: 'awaiting_other_label',
      selected: ['other'],
      completed_count: 0,
      injuries: [],
    };
    const result = await handleMessage('   ', partial, ATHLETE_ID);
    expect((result.newPartial as AnyMock).other_label).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// handleMessage — laterality
// ---------------------------------------------------------------------------

describe('handleMessage — awaiting_laterality', () => {
  const baseLateralPartial = {
    sub_step: 'awaiting_laterality',
    selected: ['hamstring'],
    completed_count: 0,
    injuries: [],
    current_detail: {
      body_part: 'hamstring',
      display_name: 'hamstring',
    },
  };

  it.each([
    ['left', 'left', 'left hamstring'],
    ['l', 'left', 'left hamstring'],
    ['right', 'right', 'right hamstring'],
    ['r', 'right', 'right hamstring'],
    ['both', 'both', 'both hamstrings'],
    ['b', 'both', 'both hamstrings'],
    ['RIGHT', 'right', 'right hamstring'],
  ])("parses '%s' → laterality=%s, display_name=%s", async (input, lat, disp) => {
    const result = await handleMessage(input, baseLateralPartial, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect((result.newPartial as AnyMock).current_detail.laterality).toBe(lat);
    expect((result.newPartial as AnyMock).current_detail.display_name).toBe(disp);
    expect((result.newPartial as AnyMock).sub_step).toBe('awaiting_severity');
  });

  it('re-asks on invalid input', async () => {
    const result = await handleMessage('dunno', baseLateralPartial, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect((result.newPartial as AnyMock).sub_step).toBe('awaiting_laterality');
    expect((result as AnyMock).reply).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// handleMessage — severity validation
// ---------------------------------------------------------------------------

describe('handleMessage — awaiting_severity', () => {
  const base = detailPartial();

  it.each(['0', '11', 'five', '', '  '])("rejects invalid severity '%s'", async (input) => {
    const result = await handleMessage(input, base, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect((result.newPartial as AnyMock).sub_step).toBe('awaiting_severity');
  });

  it('accepts valid severity 5', async () => {
    const result = await handleMessage('5', base, ATHLETE_ID);
    expect(result.done).toBe(false);
    expect((result.newPartial as AnyMock).sub_step).toBe('awaiting_active');
    expect((result.newPartial as AnyMock).current_detail.severity).toBe(5);
  });

  it('accepts boundary severity 1', async () => {
    const result = await handleMessage('1', base, ATHLETE_ID);
    expect((result.newPartial as AnyMock).current_detail.severity).toBe(1);
  });

  it('accepts boundary severity 10', async () => {
    const result = await handleMessage('10', base, ATHLETE_ID);
    expect((result.newPartial as AnyMock).current_detail.severity).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// handleMessage — per-part flow (non-bilateral: back)
// ---------------------------------------------------------------------------

describe('handleMessage — non-bilateral full flow (back)', () => {
  it('goes severity → active → notes → done for a single non-bilateral part', async () => {
    // Start after injury:done chose back
    let partial: Record<string, unknown> = {
      sub_step: 'awaiting_severity',
      selected: ['back'],
      completed_count: 0,
      injuries: [],
      current_detail: { body_part: 'back', display_name: 'back', laterality: null },
    };

    // severity
    let r = await handleMessage('4', partial, ATHLETE_ID);
    expect((r.newPartial as AnyMock).sub_step).toBe('awaiting_active');
    partial = r.newPartial;

    // active
    r = await handleMessage('yes', partial, ATHLETE_ID);
    expect((r.newPartial as AnyMock).sub_step).toBe('awaiting_notes');
    partial = r.newPartial;

    // notes
    r = await handleMessage('gets worse in the cold', partial, ATHLETE_ID);
    expect(r.done).toBe(true);
    const injuries = (r.newPartial as AnyMock).injuries as AnyMock[];
    expect(injuries).toHaveLength(1);
    expect(injuries[0]).toMatchObject({
      body_part: 'back',
      display_name: 'back',
      laterality: null,
      severity: 4,
      active: true,
      notes: 'gets worse in the cold',
    });
  });
});

// ---------------------------------------------------------------------------
// handleMessage — per-part flow (bilateral: hamstring)
// ---------------------------------------------------------------------------

describe('handleMessage — bilateral full flow (hamstring)', () => {
  it('goes laterality → severity → active → notes → done', async () => {
    let partial: Record<string, unknown> = {
      sub_step: 'awaiting_laterality',
      selected: ['hamstring'],
      completed_count: 0,
      injuries: [],
      current_detail: { body_part: 'hamstring', display_name: 'hamstring' },
    };

    let r = await handleMessage('left', partial, ATHLETE_ID);
    expect((r.newPartial as AnyMock).sub_step).toBe('awaiting_severity');
    expect((r.newPartial as AnyMock).current_detail.display_name).toBe('left hamstring');
    partial = r.newPartial;

    r = await handleMessage('7', partial, ATHLETE_ID);
    expect((r.newPartial as AnyMock).sub_step).toBe('awaiting_active');
    partial = r.newPartial;

    r = await handleMessage('no', partial, ATHLETE_ID);
    expect((r.newPartial as AnyMock).sub_step).toBe('awaiting_notes');
    partial = r.newPartial;

    r = await handleMessage('skip', partial, ATHLETE_ID);
    expect(r.done).toBe(true);
    const injuries = (r.newPartial as AnyMock).injuries as AnyMock[];
    expect(injuries[0]).toMatchObject({
      display_name: 'left hamstring',
      severity: 7,
      active: false,
      notes: null,
    });
  });
});

// ---------------------------------------------------------------------------
// handleMessage — multi-part: second part entered after first notes
// ---------------------------------------------------------------------------

describe('handleMessage — multi-part: knee + back', () => {
  it("transitions to next part after first part's notes", async () => {
    // Simulate state after injury:done with [knee, back] selected, knee as first part
    let partial: Record<string, unknown> = {
      sub_step: 'awaiting_laterality',
      selected: ['knee', 'back'],
      completed_count: 0,
      injuries: [],
      current_detail: { body_part: 'knee', display_name: 'knee' },
    };

    let r = await handleMessage('right', partial, ATHLETE_ID);
    partial = r.newPartial;
    r = await handleMessage('3', partial, ATHLETE_ID);
    partial = r.newPartial;
    r = await handleMessage('yes', partial, ATHLETE_ID);
    partial = r.newPartial;
    r = await handleMessage('none', partial, ATHLETE_ID);

    // After knee's notes, should enter back (non-bilateral → awaiting_severity)
    expect(r.done).toBe(false);
    expect((r.newPartial as AnyMock).sub_step).toBe('awaiting_severity');
    expect((r.newPartial as AnyMock).completed_count).toBe(1);
    expect((r.newPartial as AnyMock).current_detail.body_part).toBe('back');
    expect((r.newPartial as AnyMock).injuries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// onComplete
// ---------------------------------------------------------------------------

describe('onComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts 2 rows and calls both upsert functions for 2 injuries', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    (upsertProfileSection as AnyMock).mockResolvedValue(undefined);
    (upsertMemorySection as AnyMock).mockResolvedValue(undefined);

    const partial = {
      sub_step: 'awaiting_notes',
      selected: ['back', 'knee'],
      completed_count: 2,
      injuries: [
        {
          body_part: 'back',
          display_name: 'back',
          laterality: null,
          severity: 4,
          active: true,
          notes: 'lower back tightness',
        },
        {
          body_part: 'knee',
          display_name: 'right knee',
          laterality: 'right',
          severity: 2,
          active: false,
          notes: null,
        },
      ],
    };

    await injuriesStep.onComplete(ATHLETE_ID, partial);

    expect(db.insertMock).toHaveBeenCalledTimes(1);
    const insertedRows = (db.insertMock.mock.calls[0] as AnyMock[])[0] as AnyMock[];
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]).toMatchObject({
      body_part: 'back',
      severity: 4,
      status: 'active',
      notes: 'lower back tightness',
    });
    expect(insertedRows[1]).toMatchObject({
      body_part: 'right knee',
      severity: 2,
      status: 'monitoring',
      notes: null,
    });

    expect(upsertProfileSection).toHaveBeenCalledWith(
      ATHLETE_ID,
      'Injury history',
      expect.stringContaining('Back'),
    );
    expect(upsertMemorySection).toHaveBeenCalledWith(
      ATHLETE_ID,
      'injury_log.md',
      'Active injuries',
      expect.stringContaining('back'), // only active injuries
    );

    // Monitoring-only injury (right knee) should NOT appear in injury_log
    const logArg = (upsertMemorySection as AnyMock).mock.calls[0][3] as string;
    expect(logArg).not.toContain('right knee');
  });

  it('writes placeholder sections when there are no injuries', async () => {
    const db = makeDb();
    (supabaseAdmin as AnyMock).mockReturnValue(db);
    (upsertProfileSection as AnyMock).mockResolvedValue(undefined);
    (upsertMemorySection as AnyMock).mockResolvedValue(undefined);

    const partial = {
      sub_step: 'selecting',
      selected: [],
      completed_count: 0,
      injuries: [],
    };

    await injuriesStep.onComplete(ATHLETE_ID, partial);

    expect(db.insertMock).not.toHaveBeenCalled();
    expect(upsertProfileSection).toHaveBeenCalledWith(
      ATHLETE_ID,
      'Injury history',
      '_No injuries flagged during onboarding._',
    );
    expect(upsertMemorySection).toHaveBeenCalledWith(
      ATHLETE_ID,
      'injury_log.md',
      'Active injuries',
      '_No active injuries at onboarding._',
    );
  });
});
