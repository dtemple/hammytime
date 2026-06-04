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

import { handleV3Message } from '../router';
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
