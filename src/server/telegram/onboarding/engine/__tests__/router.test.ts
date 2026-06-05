import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- boundary mocks (the router orchestrates already-tested pure pieces) ---

const { sendMessage, sendChatAction, insert } = vi.hoisted(() => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendChatAction: vi.fn().mockResolvedValue(undefined),
  insert: vi.fn().mockResolvedValue({ error: null }),
}));

// NB: vi.mock paths resolve relative to THIS test file, so they must point at the
// same module files the router imports (e.g. router's '../../bot' is this file's
// '../../../bot').
vi.mock('../../../bot', () => ({
  botApiForChat: () => ({ sendMessage, sendChatAction }),
}));
vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert,
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: { name: 'Test' } }) }),
      }),
    }),
  }),
}));
vi.mock('../typing', () => ({ withTyping: (_c: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock('../history', () => ({ loadRecentHistory: vi.fn().mockResolvedValue([]) }));
vi.mock('../../dispatcher', () => ({
  selectionKeyboardFromTap: () => null,
  labelForTap: () => 'Looks right',
}));
vi.mock('@/server/agent/race-lookup', () => ({ lookupRace: vi.fn() }));
vi.mock('@/server/admin/alerts', () => ({ sendDavidAlert: vi.fn().mockResolvedValue(undefined) }));

const { commitSlots } = vi.hoisted(() => ({ commitSlots: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../commit', () => ({ commitSlots }));
vi.mock('../../plan-gen', () => ({
  generateAndPersistPlan: vi.fn().mockResolvedValue({ plan: {}, params: {} }),
}));
vi.mock('../../steps/04-plan-preview', () => ({ formatPreview: () => 'YOUR PLAN' }));

const { callExtractAndAdvance, logOnboardingRun } = vi.hoisted(() => ({
  callExtractAndAdvance: vi.fn(),
  logOnboardingRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../extract-and-advance', () => ({ callExtractAndAdvance, logOnboardingRun }));

// Partial-mock slot-state: keep the real pure helpers (isV3OnboardingComplete is
// used by the real guardrails), stub only load/save.
const { loadV3State, saveV3State } = vi.hoisted(() => ({
  loadV3State: vi.fn(),
  saveV3State: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../slots/slot-state', async (orig) => ({
  ...(await orig<typeof import('../../slots/slot-state')>()),
  loadV3State,
  saveV3State,
}));

// Partial-mock known-gaps-memory: keep the real pure parseKnownGaps/render, stub
// the DB read + write so the gap-walk turn can be driven without Supabase.
const { loadKnownGapsContent, seedKnownGapsFromFilled } = vi.hoisted(() => ({
  loadKnownGapsContent: vi.fn().mockResolvedValue(''),
  seedKnownGapsFromFilled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../known-gaps-memory', async (orig) => ({
  ...(await orig<typeof import('../../known-gaps-memory')>()),
  loadKnownGapsContent,
  seedKnownGapsFromFilled,
}));

import { handleV3Message, handleV3Callback } from '../router';
import { KNOWN_GAPS } from '@/lib/known-gaps';
import { initialV3State, type V3OnboardingState } from '../../slots/slot-state';
import type { SlotState } from '../../slots/schema';
import type { Provenance, SlotValue } from '../../slots/provenance';
import type { ExtractAdvanceOutput } from '../extract-and-advance';

function sv<const T>(value: T, provenance: Provenance = 'stated'): SlotValue<T> {
  return { value, provenance, confirmed: true };
}

function completeSlots(): SlotState {
  return {
    goal_type: sv('race'),
    experience_tier: sv('some_training'),
    goal_distance: sv('marathon'),
    goal_date: sv('2026-11-01'),
    days_per_week: sv(4),
    long_run_day: sv(0),
    injury_status: sv('none'),
  };
}

function out(p: Partial<ExtractAdvanceOutput>): ExtractAdvanceOutput {
  return {
    fills: [],
    next_action: 'ask',
    message: 'msg',
    chips: [],
    asked_slot: null,
    race_lookup_query: null,
    contradiction: null,
    numeric_unresolved: null,
    ...p,
  };
}

function ctx(messageId: number, text: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { chat: { id: 99 }, message: { message_id: messageId, text } } as any;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const athlete = { id: 'ath-1' } as any;

beforeEach(() => {
  vi.clearAllMocks();
  loadV3State.mockReset();
  saveV3State.mockResolvedValue(undefined);
});

describe('router — normal ask turn', () => {
  it('extracts, saves state, and sends the model message', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        asked_slot: 'goal_type',
        message: 'What are you training for?',
      }),
      inputTokens: 10,
      outputTokens: 5,
    });

    await handleV3Message(ctx(1, 'hi'), athlete);

    expect(callExtractAndAdvance).toHaveBeenCalledOnce();
    expect(saveV3State).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(99, 'What are you training for?', expect.anything());
    expect(commitSlots).not.toHaveBeenCalled();
  });
});

describe('router — idempotency', () => {
  it('drops a retried message (same message_id) without re-calling the model', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      last_processed_key: 'm:7',
    } as V3OnboardingState);

    await handleV3Message(ctx(7, 'hi again'), athlete);

    expect(callExtractAndAdvance).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('router — generate handoff', () => {
  it('commits slots, builds the plan, sends the preview, and marks complete', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'recap',
      slots: completeSlots(),
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'generate', message: 'building it' }),
      inputTokens: 10,
      outputTokens: 5,
    });

    await handleV3Message(ctx(2, "let's do it"), athlete);

    expect(commitSlots).toHaveBeenCalledOnce();
    // the plan preview is sent
    expect(sendMessage).toHaveBeenCalledWith(99, 'YOUR PLAN', expect.anything());
    // phase ends at 'complete'
    const lastSave = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(lastSave.phase).toBe('complete');
    expect(lastSave.committed).toBe(true);
  });

  it('does not generate when a required slot is open (guardrail override)', async () => {
    const slots = completeSlots();
    delete slots.days_per_week;
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots,
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'generate', message: 'building it' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(3, 'go'), athlete);

    expect(commitSlots).not.toHaveBeenCalled();
    // a deterministic ask for the missing slot went out instead
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      expect.stringMatching(/days per week/),
      expect.anything(),
    );
  });
});

// --- §5 fix: the experience loop is broken by enum chips ---

describe('router — a stranded experience_tier re-asks with tappable chips', () => {
  it('drops the model\'s "intermediate" fill and re-asks experience with enum chips', async () => {
    // Reproduces the live loop: the model classified the athlete as
    // "intermediate" (not in the enum) and tried to generate. The fill is
    // dropped, experience stays open, and the re-ask must carry valid chips so
    // the athlete can break out instead of seeing the same dead-end statement.
    const slots = completeSlots();
    delete slots.experience_tier;
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'recap',
      slots,
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'generate',
        message: 'building it',
        fills: [{ slot: 'experience_tier', value: 'intermediate', provenance: 'stated' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(30, 'looks right'), athlete);

    expect(commitSlots).not.toHaveBeenCalled();
    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/experience/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labels = (call[2] as any).reply_markup.inline_keyboard
      .flat()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((b: any) => b.text);
    expect(labels).toEqual(['New to running', 'Run for fun', 'Some training', 'Experienced']);
  });
});

// --- W4: chip policy vs the numeric backstop (ordering) ---

describe('router — numeric backstop keeps its chips over the chip policy', () => {
  it('a target_time turn sends the disambiguation readings, not a yes-no set', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: completeSlots(), // goal_distance = 'marathon'
    } as V3OnboardingState);
    // "4:25" parses to 265s; for a marathon that's implausibly fast → ambiguous.
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'confirm',
        message: 'A 4:25 finish?',
        fills: [{ slot: 'target_time', value: 265, provenance: 'stated' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(20, '4:25'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/which did you mean/i);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labels = (call[2] as any).reply_markup.inline_keyboard
      .flat()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((b: any) => b.text);
    expect(labels).toContain('4:25:00');
    expect(labels).toContain('0:04:25');
  });
});

// --- W3: /edit_profile fork + the "Finish my profile" gap-walk ---

function cbCtx(id = 'cb1') {
  return {
    chat: { id: 99 },
    from: { id: 99 },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    callbackQuery: { id, message: { reply_markup: { inline_keyboard: [] } } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const OPEN_GAPS_MD = ['# Known gaps', '', '- [open] strength_equipment: x', '- [open] age: y'].join(
  '\n',
);

describe('edit_profile — fork', () => {
  it('"Update something" opens the floor without changing state', async () => {
    await handleV3Callback(cbCtx(), athlete, 'v3:edit:update');
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      expect.stringMatching(/tell me what/i),
      expect.anything(),
    );
    expect(saveV3State).not.toHaveBeenCalled();
  });

  it('"Finish my profile" queues the open gaps and asks the first', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'complete',
    } as V3OnboardingState);
    loadKnownGapsContent.mockResolvedValue(OPEN_GAPS_MD);

    await handleV3Callback(cbCtx(), athlete, 'v3:edit:finish');

    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.edit_mode).toEqual({
      kind: 'finish_gaps',
      current_gap: 'strength_equipment',
      remaining: ['age'],
    });
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      KNOWN_GAPS.strength_equipment.question,
      expect.anything(),
    );
  });

  it('"Finish my profile" wraps up when there are no open gaps', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'complete',
    } as V3OnboardingState);
    loadKnownGapsContent.mockResolvedValue('# Known gaps\n');

    await handleV3Callback(cbCtx(), athlete, 'v3:edit:finish');

    expect(saveV3State).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      expect.stringMatching(/all filled in/i),
      expect.anything(),
    );
  });
});

describe('edit_profile — gap-walk turn', () => {
  it('fills the asked gap, writes known_gaps.md, and asks the next', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'complete',
      slots: completeSlots(),
      edit_mode: { kind: 'finish_gaps', current_gap: 'age', remaining: ['target_time'] },
    } as V3OnboardingState);
    loadKnownGapsContent.mockResolvedValue(OPEN_GAPS_MD);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ fills: [{ slot: 'age', value: 42, provenance: 'stated' }] }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(10, "I'm 42"), athlete);

    expect(seedKnownGapsFromFilled).toHaveBeenCalledWith(
      'ath-1',
      expect.objectContaining({ age: '42' }),
    );
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.edit_mode?.current_gap).toBe('target_time');
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      KNOWN_GAPS.target_time.question,
      expect.anything(),
    );
  });

  it('clears edit_mode and wraps up after the last gap', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'complete',
      slots: completeSlots(),
      edit_mode: { kind: 'finish_gaps', current_gap: 'age', remaining: [] },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ fills: [{ slot: 'age', value: 40, provenance: 'stated' }] }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(11, '40'), athlete);

    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.edit_mode).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      expect.stringMatching(/that's everything/i),
      expect.anything(),
    );
  });
});
