import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/server/telegram/bot', () => ({
  sendAndLog: vi.fn().mockResolvedValue(undefined),
  telegramBot: vi.fn(),
}));
vi.mock('@/server/telegram/onboarding/state', () => ({
  advanceQuestion: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/server/telegram/onboarding/index', () => ({
  onboardingSteps: new Array(7),
}));
vi.mock('@/server/admin/alerts', () => ({
  sendDavidAlert: vi.fn().mockResolvedValue(undefined),
}));

import { supabaseAdmin } from '@/lib/db';
import { sendAndLog } from '@/server/telegram/bot';
import { advanceQuestion } from '@/server/telegram/onboarding/state';
import { sendDavidAlert } from '@/server/admin/alerts';
import { renderBYOPlanTemplate, handleBuildPath, handleHelpPath } from './byo-plan';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

// ---------------------------------------------------------------------------
// renderBYOPlanTemplate
// ---------------------------------------------------------------------------

describe('renderBYOPlanTemplate', () => {
  // All vars the real template requires
  const fullValues = {
    name: 'Alice',
    age: '32',
    sex: 'F',
    timezone: 'America/Los_Angeles',
    days_per_week: '5',
    hours_per_week: '10',
    goal_race_name: 'Boston Marathon',
    goal_race_date: '2027-04-19',
    distance_mi: '26.2',
    elevation_ft: '500',
    terrain: 'road',
    race_goal_description: 'Finish — no time goal',
    tune_up_races_or_none: 'None planned.',
    past_notable_or_none: 'None reported.',
    freeform_meaning: 'To prove I can.',
    injury_history_formatted: '_No injuries flagged._',
    freeform_anything_else: '_None reported._',
    recent_mileage_mi: '35',
    longest_recent_mi: '20',
    longest_recent_x_1_5: '30',
    asthma_note_if_present: 'Has asthma.',
  };

  it('substitutes all variables', async () => {
    const result = await renderBYOPlanTemplate(fullValues);
    expect(result).toContain('Alice');
    expect(result).toContain('32');
    expect(result).toContain('Has asthma.');
    expect(result).toContain('35');
  });

  it('throws on missing variable', async () => {
    // Remove one required var — renderer should throw naming it
    const { name: _name, ...missingName } = fullValues;
    await expect(renderBYOPlanTemplate(missingName as AnyMock)).rejects.toThrow(
      'missing variable "name"',
    );
  });

  it('strips the asthma line when value is empty string', async () => {
    const result = await renderBYOPlanTemplate({
      ...fullValues,
      asthma_note_if_present: '',
    });
    // The line containing {{asthma_note_if_present}} (from the real template) should be gone
    expect(result).not.toMatch(/\{\{asthma_note_if_present\}\}/);
  });

  it('includes asthma note text when non-empty', async () => {
    const result = await renderBYOPlanTemplate({
      ...fullValues,
      asthma_note_if_present: 'Uses an inhaler.',
    });
    expect(result).toContain('Uses an inhaler.');
  });
});

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

function makeFullDb(
  overrides: {
    athlete?: Partial<Record<string, unknown>>;
    races?: Record<string, unknown>[];
    injuries?: Record<string, unknown>[];
    profileMd?: string;
    trainingProfile?: Record<string, unknown> | null;
  } = {},
) {
  const athlete = {
    id: 'athlete-1',
    name: 'Alice',
    dob: '1992-01-01',
    sex: 'F',
    timezone: 'America/Los_Angeles',
    notes: 'Goal distance: Marathon\nRecent avg miles/week: 35\nLongest recent run: 20',
    asthma: false,
    telegram_chat_id: '999',
    ...overrides.athlete,
  };

  const races = overrides.races ?? [
    {
      id: 'race-1',
      name: 'Boston Marathon',
      date: '2027-04-19',
      distance_mi: 26.2,
      elevation_ft: 500,
      terrain: 'road',
      target_type: 'time',
      target_time_sec: 13500,
      status: 'upcoming',
      created_at: '2026-05-21T00:00:00Z',
    },
  ];

  const injuries = overrides.injuries ?? [];
  const profileMd =
    overrides.profileMd ??
    '## Schedule\nTraining days per week: 5\nHours per week: 10\n\n## Goals\nDistance: Marathon\nMeaning: To prove I can do it\n\n## Anything else\n_None reported._';

  const insertMock = vi.fn().mockImplementation(() => ({
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: { id: 'plan-1' }, error: null }),
    }),
  }));
  const planVersionInsert = vi.fn().mockImplementation(() => ({
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: { id: 'version-1' }, error: null }),
    }),
  }));

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === 'athletes') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: athlete, error: null }),
          }),
        }),
      };
    }
    if (table === 'races') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: races, error: null }),
          }),
        }),
      };
    }
    if (table === 'injuries') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: injuries, error: null }),
        }),
      };
    }
    if (table === 'memory_files') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi
                .fn()
                .mockResolvedValue({ data: { content_md: profileMd }, error: null }),
            }),
          }),
        }),
      };
    }
    if (table === 'athlete_training_profile') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi
              .fn()
              .mockResolvedValue({ data: overrides.trainingProfile ?? null, error: null }),
          }),
        }),
      };
    }
    if (table === 'plans') {
      return { insert: insertMock };
    }
    if (table === 'plan_versions') {
      return { insert: planVersionInsert };
    }
    return {};
  });

  return { fromMock, insertMock, planVersionInsert };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// handleBuildPath
// ---------------------------------------------------------------------------

describe('handleBuildPath', () => {
  it('inserts a plans row with athlete_id and a plan_versions row with awaiting_paste', async () => {
    const db = makeFullDb();
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.fromMock });

    await handleBuildPath('athlete-1');

    expect(db.insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ athlete_id: 'athlete-1' }),
    );
    expect(db.planVersionInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_id: 'plan-1',
        status: 'awaiting_paste',
        generated_by: 'athlete_llm',
        plan_json: null,
      }),
    );
  });

  it('sends cover note prompting athlete to paste JSON back', async () => {
    const db = makeFullDb();
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.fromMock });

    await handleBuildPath('athlete-1');

    const calls = (sendAndLog as AnyMock).mock.calls as unknown[][];
    // Cover note is the first sendAndLog call
    const coverNote = calls[0]![2] as string;
    expect(coverNote).toContain('paste it into Claude or ChatGPT');
    expect(coverNote).toContain('paste the resulting JSON back here');
    // No paste URL in cover note
    expect(coverNote).not.toContain('/p/');
  });

  it('does not send a postfix URL message after template chunks', async () => {
    const db = makeFullDb();
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.fromMock });

    await handleBuildPath('athlete-1');

    const calls = (sendAndLog as AnyMock).mock.calls as unknown[][];
    const allText = calls.map((c) => (c[2] as string).toLowerCase()).join('\n');
    expect(allText).not.toContain('paste link');
    expect(allText).not.toContain('/p/');
  });

  it("fires sendDavidAlert with 'build path'", async () => {
    const db = makeFullDb();
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.fromMock });

    await handleBuildPath('athlete-1');

    expect(sendDavidAlert).toHaveBeenCalledWith(expect.stringContaining('build path'));
  });

  it('advances onboarding state to terminal (step = 7)', async () => {
    const db = makeFullDb();
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.fromMock });

    await handleBuildPath('athlete-1');

    expect(advanceQuestion).toHaveBeenCalledWith('athlete-1', expect.objectContaining({ step: 7 }));
  });
});

// ---------------------------------------------------------------------------
// handleHelpPath
// ---------------------------------------------------------------------------

describe('handleHelpPath', () => {
  it('sends athlete confirmation and David alert without creating plan rows', async () => {
    const db = makeFullDb();
    (supabaseAdmin as AnyMock).mockReturnValue({ from: db.fromMock });

    await handleHelpPath('athlete-1');

    expect(sendAndLog).toHaveBeenCalledWith(
      'athlete-1',
      '999',
      expect.stringContaining('David will reach out'),
    );
    expect(sendDavidAlert).toHaveBeenCalledWith(expect.stringContaining('help path'));
    expect(db.insertMock).not.toHaveBeenCalled();
    expect(db.planVersionInsert).not.toHaveBeenCalled();
  });
});
