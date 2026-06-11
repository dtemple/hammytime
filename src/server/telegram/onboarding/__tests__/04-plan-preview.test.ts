import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../plan-gen', () => ({
  generateAndPersistPlan: vi.fn(),
  getActiveTemplatePlan: vi.fn(),
  setPlanStrengthToZero: vi.fn(),
}));
vi.mock('@/server/jobs/enqueue', () => ({ enqueueJob: vi.fn() }));
vi.mock('@/server/admin/alerts', () => ({ sendDavidAlert: vi.fn().mockResolvedValue(undefined) }));

import { selectPlan, renderPlan, DRAFT_SAFETY_CAPS } from '@/lib/plan-templates';
import type { SelectorProfile } from '@/lib/plan-templates';
import { formatPreview, planPreviewStep } from '../steps/04-plan-preview';
import { generateAndPersistPlan, getActiveTemplatePlan, setPlanStrengthToZero } from '../plan-gen';
import { enqueueJob } from '@/server/jobs/enqueue';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const COMMITTED: SelectorProfile = {
  experienceTier: 'experienced',
  goalDistance: 'marathon',
  daysPerWeek: 5,
  longRunDay: 0,
  goalState: 'committed',
  targetDate: '2026-12-06',
  targetType: 'finish',
  targetTimeSec: null,
  race: { name: 'CIM', date: '2026-12-06', distanceMiles: 26.2, type: 'road' },
  injuries: [],
  today: '2026-06-02',
};

const INTENDED: SelectorProfile = {
  experienceTier: 'some_training',
  goalDistance: 'half',
  daysPerWeek: 4,
  longRunDay: 6,
  goalState: 'intended',
  targetDate: '2026-09-01',
  targetType: 'finish',
  targetTimeSec: null,
  race: null,
  injuries: [],
  today: '2026-06-02',
};

function render(profile: SelectorProfile) {
  const { template, params } = selectPlan(profile, null, DRAFT_SAFETY_CAPS);
  return { plan: renderPlan(template, params), params };
}

function buttons(
  kb: { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined,
) {
  return (kb?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// formatPreview
// ---------------------------------------------------------------------------

describe('formatPreview', () => {
  it('committed variant names the race, weeks, volume, long-run day and peak', () => {
    const { plan, params } = render(COMMITTED);
    const text = formatPreview(plan, params);
    expect(text).toMatch(/weeks to CIM/);
    expect(text).toContain('long runs on');
    expect(text).toContain('peaking at');
    expect(text).toMatch(/mi\/wk/);
    expect(text).toContain('No time goal');
  });

  it('intended/no-race variant frames the open end (no taper yet)', () => {
    const { plan, params } = render(INTENDED);
    const text = formatPreview(plan, params);
    expect(text).toContain('No race locked');
    expect(text).toContain('held off on the taper');
  });

  it('adds the time-goal nudge only when discouraged', () => {
    const { plan, params } = render(COMMITTED);
    expect(formatPreview(plan, params)).not.toContain('finishing strong before chasing');
    expect(formatPreview(plan, { ...params, timeGoalDiscouraged: true })).toContain(
      'finishing strong before chasing',
    );
  });

  it('mentions strength only when sessions > 0', () => {
    const { plan, params } = render(COMMITTED);
    expect(formatPreview(plan, { ...params, strengthSessionsPerWeek: 0 })).not.toContain(
      'strength session',
    );
    expect(formatPreview(plan, { ...params, strengthSessionsPerWeek: 2 })).toContain(
      'strength session',
    );
  });

  it('flags the partial first week when the athlete onboards mid-week', () => {
    // 2026-06-02 is a Tuesday → week 1 contains the sign-up day → ease-in.
    const { plan, params } = render(COMMITTED);
    expect(formatPreview(plan, params)).toContain('first full week');
  });

  it('omits the ease-in line when a clamped far race makes week 1 a normal future week', () => {
    const { plan, params } = render({
      ...COMMITTED,
      targetDate: '2027-06-01',
      race: { ...COMMITTED.race!, date: '2027-06-01' },
    });
    expect(formatPreview(plan, params)).not.toContain('first full week');
  });

  // R1 fix 4: a tiny horizon means an upstream invariant broke (a past goal_date
  // clamps weeks-to-race to 1 — the "~1 weeks of base and build" preview).
  it('suppresses the build arc and logs below the horizon floor (no-race variant)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { plan, params } = render(INTENDED);
    const tiny = {
      ...plan,
      metadata: {
        ...plan.metadata,
        plan_structure: { ...plan.metadata.plan_structure, total_weeks: 1 },
      },
    };
    const text = formatPreview(tiny, { ...params, totalWeeks: 1 });
    expect(text).not.toContain('1 weeks'); // the malformed phrasing
    expect(text).not.toContain('weeks of base and build'); // no numeric arc
    expect(text).not.toContain('growing from');
    expect(text).toContain('short opening block');
    expect(text).toContain('No race locked');
    expect(spy).toHaveBeenCalledWith(
      '[plan-preview] total_weeks below horizon floor',
      expect.objectContaining({ totalWeeks: 1 }),
    );
    spy.mockRestore();
  });

  it('keeps the build arc (and stays quiet) at a normal horizon', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { plan, params } = render(INTENDED);
    const text = formatPreview(plan, params);
    expect(text).toMatch(/~\d+ weeks of base and build/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('pluralizes the committed-race countdown ("1 week to", not "1 weeks to")', () => {
    const { plan, params } = render(COMMITTED);
    const oneWeek = {
      ...plan,
      metadata: {
        ...plan.metadata,
        plan_structure: { ...plan.metadata.plan_structure, total_weeks: 1 },
      },
    };
    expect(formatPreview(oneWeek, params)).toContain('1 week to CIM');
    expect(formatPreview(plan, params)).toMatch(/\d+ weeks to CIM/);
  });
});

// ---------------------------------------------------------------------------
// onEnter keyboard
// ---------------------------------------------------------------------------

describe('planPreviewStep.onEnter', () => {
  it('offers Skip strength only when the plan includes strength sessions', async () => {
    const { plan, params } = render(COMMITTED);
    (generateAndPersistPlan as AnyMock).mockResolvedValue({
      planId: 'p1',
      versionId: 'v1',
      plan,
      params: { ...params, strengthSessionsPerWeek: 2 },
    });
    const withStrength = await planPreviewStep.onEnter!('a1');
    expect(buttons(withStrength.keyboard as AnyMock)).toEqual(
      expect.arrayContaining(['plan:good', 'plan:adjust', 'plan:nostrength']),
    );

    (generateAndPersistPlan as AnyMock).mockResolvedValue({
      planId: 'p1',
      versionId: 'v1',
      plan,
      params: { ...params, strengthSessionsPerWeek: 0 },
    });
    const noStrength = await planPreviewStep.onEnter!('a1');
    expect(buttons(noStrength.keyboard as AnyMock)).not.toContain('plan:nostrength');
  });

  it('returns a retry fallback (and alerts) when generation throws', async () => {
    (generateAndPersistPlan as AnyMock).mockRejectedValue(new Error('boom'));
    const res = await planPreviewStep.onEnter!('a1');
    expect(res.text).toMatch(/snag/i);
    expect(buttons(res.keyboard as AnyMock)).toContain('plan:retry');
  });
});

// ---------------------------------------------------------------------------
// handleCallback
// ---------------------------------------------------------------------------

describe('planPreviewStep.handleCallback', () => {
  it('plan:good completes the step (advances to enrichment)', async () => {
    const res = await planPreviewStep.handleCallback!('plan:good', {}, 'a1');
    expect(res.done).toBe(true);
  });

  it('plan:adjust enqueues a tg_message keyed on the version id and completes', async () => {
    (getActiveTemplatePlan as AnyMock).mockResolvedValue({
      planId: 'p1',
      versionId: 'v9',
      plan: {},
    });
    const res = await planPreviewStep.handleCallback!('plan:adjust', {}, 'a1');
    expect(enqueueJob).toHaveBeenCalledWith(
      'tg_message',
      'tg_adjust:a1:v9',
      expect.objectContaining({ athlete_id: 'a1', text: expect.stringContaining('adjust') }),
    );
    expect(res.done).toBe(true);
  });

  it('plan:nostrength re-renders with no strength and re-shows the preview', async () => {
    const { plan, params } = render(COMMITTED);
    (getActiveTemplatePlan as AnyMock).mockResolvedValue({ planId: 'p1', versionId: 'v1', plan });
    (setPlanStrengthToZero as AnyMock).mockResolvedValue({
      plan,
      params: { ...params, strengthSessionsPerWeek: 0 },
    });
    const res = await planPreviewStep.handleCallback!('plan:nostrength', {}, 'a1');
    expect(setPlanStrengthToZero).toHaveBeenCalledWith('a1', 'v1');
    expect(res.done).toBe(false);
    if (!res.done) {
      expect(res.reply).toBeTruthy();
      expect(buttons(res.replyMarkup as AnyMock)).not.toContain('plan:nostrength');
    }
  });
});
