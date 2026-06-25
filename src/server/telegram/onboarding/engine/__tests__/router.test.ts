import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

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
const { supersedeActiveTemplatePlan } = vi.hoisted(() => ({
  supersedeActiveTemplatePlan: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../plan-gen', () => ({
  generateAndPersistPlan: vi.fn().mockResolvedValue({ plan: {}, params: {} }),
  supersedeActiveTemplatePlan,
}));
const { formatPreview } = vi.hoisted(() => ({ formatPreview: vi.fn(() => 'YOUR PLAN') }));
vi.mock('../../steps/04-plan-preview', () => ({ formatPreview }));

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

// Dormant-state helpers (v4 off-ramp): stubbed so the router's off-ramp branch can
// be driven without Supabase or the grammy bot that pause.ts pulls in.
const { enterDormant, exitDormant, setCheckBack } = vi.hoisted(() => ({
  enterDormant: vi.fn().mockResolvedValue(undefined),
  exitDormant: vi.fn().mockResolvedValue(false),
  setCheckBack: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../pause', () => ({ enterDormant, exitDormant, setCheckBack }));

import { handleV3Message, handleV3Callback, startNextEvent } from '../router';
import { lookupRace } from '@/server/agent/race-lookup';
import { sendDavidAlert } from '@/server/admin/alerts';
import { KNOWN_GAPS } from '@/lib/known-gaps';
import { recapDisplayedSlots } from '../guardrails';
import { initialV3State, type V3OnboardingState } from '../../slots/slot-state';
import type { SlotState } from '../../slots/schema';
import type { Provenance, SlotValue } from '../../slots/provenance';
import type { ExtractAdvanceOutput } from '../extract-and-advance';

// Pin the clock: the past-goal_date guard (R1 fix 3) runs inside the real
// guardrails these tests exercise, so the 2026 fixture dates must never rot.
beforeAll(() => vi.useFakeTimers({ now: new Date('2026-06-10T12:00:00-07:00'), toFake: ['Date'] }));
afterAll(() => vi.useRealTimers());

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
    goal_distance_mi: null,
    contradiction: null,
    numeric_unresolved: null,
    intents: [],
    reflection: null,
    volume_goal: null,
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

// --- Confirm-loop fix (2026-06-05): the chip-yes fast path ---

describe('router — pending-confirm chip-yes fast path', () => {
  it('resolves a pending confirm on a yes tap without calling the model', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'recap',
      slots: {
        ...completeSlots(),
        days_per_week: { value: 4, provenance: 'inferred', confirmed: false },
        long_run_day: { value: 0, provenance: 'inferred', confirmed: false },
      },
      pending_confirm: { slot: 'days_per_week', value: 4, attempts: 1 },
    } as V3OnboardingState);

    await handleV3Callback(cbCtx('cbyes'), athlete, 'v3:yes');

    expect(callExtractAndAdvance).not.toHaveBeenCalled();
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.slots.days_per_week?.confirmed).toBe(true);
    // chains to the next unconfirmed inferred slot's confirm
    expect(saved.pending_confirm).toEqual({ slot: 'long_run_day', value: 0, attempts: 1 });
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      expect.stringMatching(/long-run day/i),
      expect.anything(),
    );
  });

  it('routes a typed affirmation through the model (fromChip is false)', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'recap',
      slots: completeSlots(),
      pending_confirm: { slot: 'days_per_week', value: 4, attempts: 1 },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'ask', asked_slot: 'goal_type', message: 'x' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(40, 'looks right'), athlete);

    expect(callExtractAndAdvance).toHaveBeenCalledOnce();
  });

  it('routes a "Fix it" tap through the model (value is not yes)', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'recap',
      slots: completeSlots(),
      pending_confirm: { slot: 'days_per_week', value: 4, attempts: 1 },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'ask', asked_slot: 'days_per_week', message: 'what is it?' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Callback(cbCtx('cbfix'), athlete, 'v3:let me fix that');

    expect(callExtractAndAdvance).toHaveBeenCalledOnce();
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

// --- W8: deterministic distance derivation + the uncatalogued-goal pocket ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function labels(call: any[]): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((call[2] as any).reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.text);
}

describe('router — confirmed-race distance derivation (V3-W8)', () => {
  it('derives goal_distance in code from a looked-up race (no separate distance confirm)', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race') },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'confirm', race_lookup_query: 'CIM', message: 'looking' }),
      inputTokens: 1,
      outputTokens: 1,
    });
    vi.mocked(lookupRace).mockResolvedValue({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      found: { canonical_name: 'CIM', date: '2026-12-06', distance_mi: 26.2 } as any,
    });

    await handleV3Message(ctx(50, 'doing CIM'), athlete);

    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.slots.goal_distance).toEqual({
      value: 'marathon',
      provenance: 'stated',
      confirmed: true,
    });
    expect(saved.out_of_catalog).toBeUndefined();
  });

  it('an in-catalog race supersedes an ACCEPTED pocket — same-bucket pivot (stale-pocket fix)', async () => {
    // Chase's shape post-accept: 44-mi pocket accepted, marathon proxy in the
    // slots. Pivoting to CIM (also a marathon) must clear the pocket so commit
    // writes the bucket nominal, not 44, onto the new race's row.
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race'), goal_distance: sv('marathon') },
      out_of_catalog: {
        words: '44 miles in the mountains',
        distance_mi: 44,
        proxy: 'marathon',
        consent: 'accepted',
      },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'confirm', race_lookup_query: 'CIM', message: 'looking' }),
      inputTokens: 1,
      outputTokens: 1,
    });
    vi.mocked(lookupRace).mockResolvedValue({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      found: { canonical_name: 'CIM', date: '2026-12-06', distance_mi: 26.2 } as any,
    });

    await handleV3Message(ctx(54, 'actually let me do CIM instead'), athlete);

    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.out_of_catalog).toBeUndefined();
    expect(saved.slots.goal_race?.value).toBe('CIM');
    expect(saved.slots.goal_distance?.value).toBe('marathon');
    expect(saved.intents).toEqual(['44 miles in the mountains']);
  });

  it('an in-catalog race supersedes a PENDING pocket too (no false reconcile-accept)', async () => {
    // Without the clear, reconcilePocket sees goal_distance = proxy and wrongly
    // marks the pocket accepted — the same stale state by another road.
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race') },
      out_of_catalog: {
        words: '44 miles in the mountains',
        distance_mi: 44,
        proxy: 'marathon',
        consent: 'pending',
      },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'confirm', race_lookup_query: 'CIM', message: 'looking' }),
      inputTokens: 1,
      outputTokens: 1,
    });
    vi.mocked(lookupRace).mockResolvedValue({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      found: { canonical_name: 'CIM', date: '2026-12-06', distance_mi: 26.2 } as any,
    });

    await handleV3Message(ctx(55, 'nah, make it CIM'), athlete);

    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.out_of_catalog).toBeUndefined();
    expect(saved.intents).toEqual(['44 miles in the mountains']);
  });
});

describe('router — beyond-50k race takes the off-ramp (V4-W4)', () => {
  it('a 100-mile race is acknowledged and asks for a shorter event — no bucket/proxy/pocket', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race') },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'confirm',
        race_lookup_query: 'Western States',
        message: 'looking',
      }),
      inputTokens: 1,
      outputTokens: 1,
    });
    vi.mocked(lookupRace).mockResolvedValue({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      found: { canonical_name: 'Western States 100', date: '2026-06-27', distance_mi: 100 } as any,
    });

    await handleV3Message(ctx(51, 'Western States'), athlete);

    expect(commitSlots).not.toHaveBeenCalled();
    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/Western States 100/);
    expect(call[1]).toMatch(/top out at the 50k/i);
    expect(labels(call)).toEqual([]); // no consent chips — an open ask, not a proxy offer
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.slots.goal_distance).toBeUndefined(); // no bucket/proxy write
    expect(saved.out_of_catalog).toBeUndefined(); // off-ramp, not a pocket
    expect(saved.intents).toContain('Western States 100'); // rides as coach context
  });
});

describe('router — stated beyond-50k distance takes the off-ramp (V4-W4)', () => {
  it('"44 miles" with no race lookup off-ramps, no pocket', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race') },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'ask', goal_distance_mi: 44, message: 'got it' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(52, '44 miles in the mountains'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/top out at the 50k/i);
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.out_of_catalog).toBeUndefined(); // off-ramp, not a pocket
    expect(saved.slots.goal_distance).toBeUndefined();
    expect(saved.intents).toContain('44 miles in the mountains'); // rides as coach context
  });

  it('a stated 50k is bucketed in code, no off-ramp (V4-W4)', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race') },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'ask', goal_distance_mi: 35, message: 'a 50k then' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(54, 'a 35-mile trail ultra'), athlete);

    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.slots.goal_distance?.value).toBe('50k');
    expect(saved.out_of_catalog).toBeUndefined();
  });

  it('an in-bucket stated distance is set in code, no pocket', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race') },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'ask', goal_distance_mi: 13.1, message: 'a half then' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(53, 'about 13 miles'), athlete);

    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.slots.goal_distance?.value).toBe('half');
    expect(saved.out_of_catalog).toBeUndefined();
  });
});

describe('router — pocket consent chips (V3-W8)', () => {
  function pocketState(): V3OnboardingState {
    return {
      ...initialV3State(null),
      phase: 'intake',
      slots: {
        goal_type: sv('race'),
        experience_tier: sv('some_training'),
        days_per_week: sv(4),
        long_run_day: sv(0),
        goal_date: sv('2026-09-15'),
        injury_status: sv('none'),
      },
      out_of_catalog: {
        words: 'Rae Lakes Loop, 44mi',
        distance_mi: 44,
        proxy: 'marathon',
        consent: 'pending',
      },
    } as V3OnboardingState;
  }

  it('"Do that" accepts the proxy without calling the model and generates', async () => {
    loadV3State.mockResolvedValue(pocketState());

    await handleV3Callback(cbCtx('cbpocketyes'), athlete, 'v3:yes');

    expect(callExtractAndAdvance).not.toHaveBeenCalled();
    expect(commitSlots).toHaveBeenCalledOnce(); // all required slots filled → generate
  });

  it('"Not now" declines, clears the pocket, and re-offers without the model', async () => {
    loadV3State.mockResolvedValue(pocketState());

    await handleV3Callback(cbCtx('cbpocketno'), athlete, 'v3:no');

    expect(callExtractAndAdvance).not.toHaveBeenCalled();
    expect(commitSlots).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      expect.stringMatching(/want to aim at something/i),
      expect.anything(),
    );
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.out_of_catalog).toBeUndefined();
  });
});

// --- R1 fix 2: the recap-affirm fast path (the Nathan regression) ---

describe('router — recap-affirm fast path (R1 fix 2)', () => {
  // The Nathan state at recap time: core complete, the inferred slots displayed
  // in the recap but unconfirmed — the shape that produced five serial
  // "Quick check" turns after he tapped "Looks right".
  function nathanState(): V3OnboardingState {
    const slots: SlotState = {
      ...completeSlots(),
      goal_date: { value: '2026-09-01', provenance: 'inferred', confirmed: false },
      experience_tier: { value: 'experienced', provenance: 'inferred', confirmed: false },
      days_per_week: { value: 3, provenance: 'inferred', confirmed: false },
      long_run_day: { value: 3, provenance: 'inferred', confirmed: false },
    };
    const base = { ...initialV3State(null), phase: 'recap' as const, slots };
    return { ...base, recap_shown: recapDisplayedSlots(base) };
  }

  it('"Looks right" on the recap generates with zero Quick-check turns and no model call', async () => {
    loadV3State.mockResolvedValue(nathanState());

    await handleV3Callback(cbCtx('cbrecapyes'), athlete, 'v3:yes');

    expect(callExtractAndAdvance).not.toHaveBeenCalled();
    expect(commitSlots).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(99, 'YOUR PLAN', expect.anything());
    expect(sendMessage).not.toHaveBeenCalledWith(
      99,
      expect.stringMatching(/Quick check/),
      expect.anything(),
    );
  });

  it('pending_confirm takes precedence over the recap snapshot', async () => {
    loadV3State.mockResolvedValue({
      ...nathanState(),
      pending_confirm: { slot: 'days_per_week', value: 3, attempts: 1 },
    });

    await handleV3Callback(cbCtx('cbprec'), athlete, 'v3:yes');

    // resolved by the pending-confirm path: the single slot confirms, then the
    // gate chains; either way the model is never called.
    expect(callExtractAndAdvance).not.toHaveBeenCalled();
    const saved =
      (saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState | undefined) ?? undefined;
    if (saved) expect(saved.slots.days_per_week?.confirmed).toBe(true);
  });

  it('a recap turn records recap_shown on the saved state', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: completeSlots(),
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'recap', message: 'here is what I have' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(60, 'that is everything'), athlete);

    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.recap_shown?.length).toBeGreaterThan(0);
  });
});

// --- R1 fixes 1 + 5: the mile turn — catalog floor, pocket, pace envelope ---

describe('router — the Nathan mile turn (R1 fixes 1 + 5)', () => {
  it('"1 mile in under 5 minutes" opens the short pocket AND keeps the 300s target', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race') },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        goal_distance_mi: 1,
        message: 'got it',
        fills: [{ slot: 'target_time', value: 300, provenance: 'stated' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(70, '1 mile in under 5 minutes'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/5K block/); // the short-side pocket offer
    expect(labels(call)).toEqual(['Do that', 'Not now']);
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.out_of_catalog).toMatchObject({ distance_mi: 1, proxy: '5k', consent: 'pending' });
    expect(saved.slots.goal_distance).toBeUndefined(); // never silently a 5K
    // the envelope (1 mi × 230–1500 s/mi) accepts 300s — sub-5 survives to commit
    expect(saved.slots.target_time?.value).toBe(300);
  });

  it('an implausible time for the pocketed distance is cleared and re-asked', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race') },
      out_of_catalog: {
        words: 'a fast mile',
        distance_mi: 1,
        proxy: '5k',
        consent: 'pending',
      },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        message: 'noted',
        fills: [{ slot: 'target_time', value: 30, provenance: 'stated' }], // a 30-second mile
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(71, '30 seconds'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/doesn't look right for the mile/i);
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.slots.target_time?.value).toBeNull();
  });
});

// --- R1 fix 3 (d): commit refuses a past target_date ---

describe('router — commit refusal on a past target_date (R1 fix 3 / T-9)', () => {
  it('resets the date, routes back to intake, and alerts David instead of generating', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'recap',
      slots: completeSlots(),
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'generate', message: 'building it' }),
      inputTokens: 1,
      outputTokens: 1,
    });
    commitSlots.mockRejectedValueOnce(
      Object.assign(new Error('target_date 2025-09-01 is in the past'), {
        code: 'PAST_TARGET_DATE',
      }),
    );

    await handleV3Message(ctx(80, 'go'), athlete);

    expect(vi.mocked(sendDavidAlert)).toHaveBeenCalledWith(
      expect.stringMatching(/past target_date/),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      expect.stringMatching(/already behind us/i),
      expect.anything(),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(99, 'YOUR PLAN', expect.anything());
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.phase).toBe('intake');
    expect(saved.slots.goal_date?.value).toBeNull();
    expect(saved.slots.goal_date?.provenance).toBe('unknown');
  });
});

// --- R1 fix 6: one retry on a failed model call ---

describe('router — extract-call retry (R1 fix 6)', () => {
  it('retries once on a transient failure and proceeds normally', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
    } as V3OnboardingState);
    callExtractAndAdvance.mockRejectedValueOnce(new Error('api blip')).mockResolvedValueOnce({
      output: out({ next_action: 'ask', asked_slot: 'goal_type', message: 'what for?' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(90, 'hi'), athlete);

    expect(callExtractAndAdvance).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(99, 'what for?', expect.anything());
    expect(sendMessage).not.toHaveBeenCalledWith(
      99,
      expect.stringMatching(/Lost the thread/),
      expect.anything(),
    );
  });

  it('falls back after the second failure, once', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
    } as V3OnboardingState);
    callExtractAndAdvance.mockRejectedValue(new Error('api down'));

    await handleV3Message(ctx(91, 'hi'), athlete);

    expect(callExtractAndAdvance).toHaveBeenCalledTimes(2);
    const fallbacks = sendMessage.mock.calls.filter((c) => /Lost the thread/.test(String(c[1])));
    expect(fallbacks).toHaveLength(1);
    expect(saveV3State).not.toHaveBeenCalled();
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
      { excludeRaceOnly: false },
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

// --- R2: the reflection turn — mirror composition, chips, redo, intents ---

describe('router — the reflection turn (R2)', () => {
  const MIRROR =
    "Here's what I'm hearing — the headline is a sub-5 mile, and behind it speed, strength, and staying ahead of injury.";

  function freshIntake(): V3OnboardingState {
    return { ...initialV3State(null), phase: 'intake', slots: {} };
  }

  it('the Nathan ramble: mirror + boundary lead + reflection chips, intents and 300s saved', async () => {
    loadV3State.mockResolvedValue(freshIntake());
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        goal_distance_mi: 1,
        message: 'got it',
        reflection: MIRROR,
        intents: ['speed at shorter distances', 'build muscle strength and resilience'],
        fills: [
          { slot: 'goal_type', value: 'race', provenance: 'stated' },
          { slot: 'target_time', value: 300, provenance: 'stated' },
        ],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(80, 'long ramble about a sub-5 mile'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/^Here's what I'm hearing/);
    expect(call[1]).toContain('One thing to be straight about: a mile race is shorter');
    expect(call[1]).toContain('treating 5:00 as the goal'); // deterministic templating
    expect(labels(call)).toEqual(['Do that', 'Not quite my goal']);
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.reflected).toBe(true);
    expect(saved.intents).toEqual([
      'speed at shorter distances',
      'build muscle strength and resilience',
    ]);
    expect(saved.out_of_catalog).toMatchObject({ distance_mi: 1, proxy: '5k', consent: 'pending' });
    expect(saved.slots.target_time?.value).toBe(300);
  });

  it('the mirror survives a guardrail override (composition happens at the send point)', async () => {
    loadV3State.mockResolvedValue(freshIntake());
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'generate', // open required slots → overridden to a deterministic ask
        message: 'building it now',
        reflection: MIRROR,
        fills: [{ slot: 'goal_type', value: 'race', provenance: 'stated' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(81, 'I want to race'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/^Here's what I'm hearing/);
    expect(call[1]).toContain('One more thing before I build your plan'); // the override's ask
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.reflected).toBe(true);
  });

  it('the mirror survives the numeric backstop (no boundary lead on a backstop message)', async () => {
    loadV3State.mockResolvedValue(freshIntake());
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        goal_distance_mi: 1,
        message: 'noted',
        reflection: MIRROR,
        fills: [
          { slot: 'goal_type', value: 'race', provenance: 'stated' },
          { slot: 'target_time', value: 30, provenance: 'stated' }, // a 30-second mile
        ],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(82, 'a 30 second mile'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/^Here's what I'm hearing/);
    expect(call[1]).toMatch(/doesn't look right for the mile/i);
    expect(call[1]).not.toContain('One thing to be straight about'); // backstop owns the body
  });

  it('the mirror rides the race-lookup result ("Found it — …")', async () => {
    loadV3State.mockResolvedValue(freshIntake());
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'confirm',
        race_lookup_query: 'CIM',
        message: 'looking',
        reflection: MIRROR,
        fills: [{ slot: 'goal_type', value: 'race', provenance: 'stated' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });
    vi.mocked(lookupRace).mockResolvedValue({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      found: { canonical_name: 'CIM', date: '2026-12-06', distance_mi: 26.2 } as any,
    });

    await handleV3Message(ctx(83, 'CIM, plus a ramble'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/^Here's what I'm hearing/);
    expect(call[1]).toContain('Found it — CIM');
    expect(labels(call)).toEqual(["That's it", 'Not quite']); // no pocket → race-confirm chips
  });

  it('an empty reflection adds no prefix; the flip still happens off the goal content', async () => {
    loadV3State.mockResolvedValue(freshIntake());
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        message: 'CIM — nice. When is it?',
        fills: [{ slot: 'goal_type', value: 'race', provenance: 'stated' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(84, 'I want to run CIM'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toBe('CIM — nice. When is it?');
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.reflected).toBe(true);
  });

  it('a pocket opening past the reflection turn keeps the standard chips', async () => {
    // The short-side 5k pocket (a sub-floor mile) — the long-side beyond-50k case
    // off-ramps now (V4-W4), but the reflection-vs-standard chip logic is unchanged.
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race') }, // goal content already present → reflected (grandfather)
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'ask', goal_distance_mi: 1, message: 'got it' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(85, 'a mile actually'), athlete);

    expect(labels(sendMessage.mock.calls.at(-1)!)).toEqual(['Do that', 'Not now']);
  });

  it('"Not quite my goal" takes the redo: restatement ask, reflected re-armed, intents kept', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race') },
      reflected: true,
      intents: ['speed at shorter distances'],
      out_of_catalog: {
        words: '1 mile in under 5 minutes',
        distance_mi: 1,
        proxy: '5k',
        consent: 'pending',
      },
    } as V3OnboardingState);

    await handleV3Callback(cbCtx('cbredo'), athlete, 'v3:no');

    expect(callExtractAndAdvance).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      expect.stringMatching(/tell me again what you're going for/i),
      expect.anything(),
    );
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.reflected).toBe(false);
    expect(saved.reflection_redone).toBe(true);
    expect(saved.intents).toEqual(['speed at shorter distances']);
    expect(saved.out_of_catalog).toBeUndefined();
  });

  it('the gap-walk ignores model intents (post-commit they reach nothing)', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'complete',
      slots: completeSlots(),
      edit_mode: { kind: 'finish_gaps', current_gap: 'age', remaining: [] },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        fills: [{ slot: 'age', value: 42, provenance: 'stated' }],
        intents: ['a stray intent'],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(86, "I'm 42 and want to get stronger"), athlete);

    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.intents).toBeUndefined();
  });

  it('finishOnboarding hands the intents to the preview', async () => {
    const slots: SlotState = {
      ...completeSlots(),
    };
    const base = {
      ...initialV3State(null),
      phase: 'recap' as const,
      slots,
      intents: ['build muscle strength'],
    };
    loadV3State.mockResolvedValue({ ...base, recap_shown: recapDisplayedSlots(base) });

    await handleV3Callback(cbCtx('cbgenintents'), athlete, 'v3:yes');

    expect(commitSlots).toHaveBeenCalledOnce();
    expect(formatPreview).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ intents: ['build muscle strength'] }),
    );
  });
});

// --- staging fixes (2026-06-10): volume-goal boundary + the distance cross-fire ---

describe('router — volume-goal boundary (ULTRA_SUPPORT §6 interim)', () => {
  const MIRROR = "Here's what I'm hearing — 100 miles every month, sustained for a year.";

  function freshIntake(): V3OnboardingState {
    return { ...initialV3State(null), phase: 'intake', slots: {} };
  }

  it('a volume-only ramble gets mirror + boundary + the two redirect chips; the clause rides as an intent', async () => {
    loadV3State.mockResolvedValue(freshIntake());
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        message: 'sounds good',
        reflection: MIRROR,
        volume_goal: { miles: 100, period: 'month' },
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(90, 'I wanna run 100 miles every month for the next year'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/^Here's what I'm hearing/);
    expect(call[1]).toContain(
      "One thing to be straight about: a monthly mileage target isn't something I can coach you toward yet",
    );
    expect(labels(call)).toEqual(['Keep me fit', 'Train for a race']);
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.intents).toEqual(['100 miles a month']);
    expect(saved.reflected).toBe(true);
    expect(saved.out_of_catalog).toBeUndefined(); // no pocket — this is a redirect
  });

  it('a volume target alongside a race lookup demotes silently — the race turn stands', async () => {
    loadV3State.mockResolvedValue(freshIntake());
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'confirm',
        message: 'looking',
        race_lookup_query: 'CIM',
        volume_goal: { miles: 60, period: 'month' },
        fills: [{ slot: 'goal_type', value: 'race', provenance: 'stated' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });
    vi.mocked(lookupRace).mockResolvedValue({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      found: { canonical_name: 'CIM', date: '2026-12-06', distance_mi: 26.2 } as any,
    });

    await handleV3Message(ctx(91, 'CIM in December, and at least 60 miles a month'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toContain('Found it — CIM');
    expect(call[1]).not.toContain('mileage target');
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.intents).toEqual(['60 miles a month']);
  });

  it('a race already in state demotes silently too (the existing-race hole)', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race'), goal_distance: sv('marathon') },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        message: 'noted — when is the race?',
        volume_goal: { miles: 100, period: 'month' },
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(92, 'also I want 100 miles a month'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toBe('noted — when is the race?');
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.intents).toEqual(['100 miles a month']);
  });

  it('a restated volume target does not re-fire the boundary (intent dedupe is the gate)', async () => {
    loadV3State.mockResolvedValue({
      ...freshIntake(),
      reflected: true,
      intents: ['100 miles a month'],
    });
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        message: 'I hear you — the two paths are still general fitness or a race.',
        volume_goal: { miles: 100, period: 'month' },
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(93, 'no really, 100 miles a month'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).not.toContain("isn't something I can coach you toward");
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.intents).toEqual(['100 miles a month']); // no dupe
  });

  it('a boundary turn blocks a same-turn generate — never "happily agree" into the plan', async () => {
    const slots: SlotState = {
      goal_type: sv('general_fitness'),
      goal_distance: sv('keep_fit'),
      experience_tier: sv('some_training'),
      days_per_week: sv(3),
      long_run_day: sv(3),
      injury_status: sv('none'),
    };
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots,
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'generate',
        message: 'building it',
        volume_goal: { miles: 100, period: 'month' },
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(94, '100 miles a month, build it'), athlete);

    expect(commitSlots).not.toHaveBeenCalled();
    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toContain("isn't something I can coach you toward yet");
  });
});

describe('router — target/distance cross-fire (the mile enum-bypass net)', () => {
  it('a fresh 5k fill against a held 5:00 fires and questions the pairing', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race'), target_time: sv(300) },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        message: 'a 5k then',
        fills: [{ slot: 'goal_distance', value: '5k', provenance: 'stated' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(95, 'call it a 5k'), athlete);

    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toContain('I had 5:00 as your goal time');
    expect(call[1]).toMatch(/doesn't fit a 5k/i);
    expect(call[1]).toMatch(/distance actually different/i);
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.slots.target_time?.value).toBeNull();
  });

  it('a legitimate pair never fires (3:55 marathon)', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race'), target_time: sv(14154) },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        message: 'marathon it is',
        fills: [{ slot: 'goal_distance', value: 'marathon', provenance: 'stated' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(96, 'a marathon'), athlete);

    expect(sendMessage.mock.calls.at(-1)![1]).toBe('marathon it is');
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.slots.target_time?.value).toBe(14154);
  });

  it('a typed pocket-accept is protected: reconcile runs first, the envelope validates the real mile', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { goal_type: sv('race'), target_time: sv(300) },
      out_of_catalog: { words: 'a sub-5 mile', distance_mi: 1, proxy: '5k', consent: 'pending' },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        message: 'great — locking in the 5K block',
        fills: [{ slot: 'goal_distance', value: '5k', provenance: 'stated' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(97, 'yeah do that'), athlete);

    expect(sendMessage.mock.calls.at(-1)![1]).toBe('great — locking in the 5K block');
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.out_of_catalog?.consent).toBe('accepted');
    expect(saved.slots.target_time?.value).toBe(300); // sub-5 survives, again
  });

  it('a keep_fit fill with a held time never fires (no range to validate)', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: { target_time: sv(300) },
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({
        next_action: 'ask',
        message: 'keeping you fit then',
        fills: [{ slot: 'goal_distance', value: 'keep_fit', provenance: 'stated' }],
      }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(98, 'just keep me fit'), athlete);

    expect(sendMessage.mock.calls.at(-1)![1]).toBe('keeping you fit then');
  });
});

// --- v4 / V4-W2: the entry off-ramp + dormant state ---

function completeFitnessSlots(): SlotState {
  return {
    goal_type: sv('general_fitness'),
    goal_distance: sv('keep_fit'),
    experience_tier: sv('some_training'),
    days_per_week: sv(4),
    long_run_day: sv(0),
    injury_status: sv('none'),
  };
}

describe('router — v4 entry off-ramp', () => {
  it('first generate for a no-event athlete sends the offer, not a plan, and goes dormant', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'recap',
      slots: completeFitnessSlots(),
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'generate', message: 'building it' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(200, "nah, just to stay fit"), athlete);

    // No keep_fit plan: not committed, not generated.
    expect(commitSlots).not.toHaveBeenCalled();
    // Dormant, no check-back date yet.
    expect(enterDormant).toHaveBeenCalledWith('ath-1', null);
    // The honest offer went out (no chips — a named goal here re-opens the flow).
    expect(sendMessage).toHaveBeenCalledWith(99, expect.stringMatching(/built around training for/i), {});
    // State marks the offer made and stays in intake so the reply flows normally.
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.off_ramp_offered).toBe(true);
    expect(saved.phase).toBe('intake');
    expect(sendDavidAlert).toHaveBeenCalled();
  });

  it('second generate (offer already made) acknowledges and offers the check-back chips', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
      slots: completeFitnessSlots(),
      off_ramp_offered: true,
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'generate', message: 'building it' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(201, "nope, nothing on the calendar"), athlete);

    expect(commitSlots).not.toHaveBeenCalled();
    // Acknowledgement + the four check-back chips.
    const call = sendMessage.mock.calls.at(-1)!;
    expect(call[1]).toMatch(/check back/i);
    expect(call[2]).toHaveProperty('reply_markup');
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.phase).toBe('off_ramp');
  });

  it('a check-back chip sets the nudge date and confirms, no model call', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'off_ramp',
      slots: completeFitnessSlots(),
      off_ramp_offered: true,
    } as V3OnboardingState);

    await handleV3Callback(cbCtx('cb3m'), athlete, 'v3:checkback:3m');

    expect(callExtractAndAdvance).not.toHaveBeenCalled();
    expect(setCheckBack).toHaveBeenCalledOnce();
    const [id, iso] = setCheckBack.mock.calls[0]!;
    expect(id).toBe('ath-1');
    // ~3 months out from the pinned clock (2026-06-10) → September 2026.
    expect(iso).toMatch(/^2026-09-/);
    expect(sendMessage).toHaveBeenCalledWith(99, expect.stringMatching(/in 3 months/i), {});
  });

  it('the "Don\'t bother" chip clears the check-back and ends cleanly', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'off_ramp',
      slots: completeFitnessSlots(),
      off_ramp_offered: true,
    } as V3OnboardingState);

    await handleV3Callback(cbCtx('cbnone'), athlete, 'v3:checkback:none');

    expect(setCheckBack).toHaveBeenCalledWith('ath-1', null);
    expect(sendMessage).toHaveBeenCalledWith(99, expect.stringMatching(/leave it here/i), {});
  });

  it('a real event after an off-ramp wakes the dormant athlete and builds the plan', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'recap',
      slots: completeSlots(), // a dated race
      off_ramp_offered: true, // lingering from an earlier off-ramp beat
    } as V3OnboardingState);
    callExtractAndAdvance.mockResolvedValue({
      output: out({ next_action: 'generate', message: 'building it' }),
      inputTokens: 1,
      outputTokens: 1,
    });

    await handleV3Message(ctx(202, "actually I signed up for CIM"), athlete);

    expect(exitDormant).toHaveBeenCalledWith('ath-1');
    expect(commitSlots).toHaveBeenCalledOnce();
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.phase).toBe('complete');
  });
});

// --- /next_event re-activation (V4-W3b) ---

describe('next_event — re-activation', () => {
  it('gates on completion: a still-onboarding athlete is told to finish first', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'intake',
    } as V3OnboardingState);

    await startNextEvent(athlete, 99);

    expect(sendMessage).toHaveBeenCalledWith(
      99,
      expect.stringMatching(/still getting you set up/i),
      expect.anything(),
    );
    expect(saveV3State).not.toHaveBeenCalled();
  });

  it('mid-block: warns the current plan will be swapped and names the race', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'complete',
      slots: { ...completeSlots(), goal_race: sv('CIM') },
    } as V3OnboardingState);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startNextEvent({ id: 'ath-1', pause_reason: null } as any, 99);

    const [, text] = sendMessage.mock.calls.at(-1)!;
    expect(text).toMatch(/CIM/);
    expect(text).toMatch(/swaps/i);
    expect(saveV3State).not.toHaveBeenCalled();
  });

  it('dormant: a soft re-activation prompt, no "swap" warning', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'complete',
      slots: completeSlots(),
    } as V3OnboardingState);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startNextEvent({ id: 'ath-1', pause_reason: 'dormant' } as any, 99);

    const [, text] = sendMessage.mock.calls.at(-1)!;
    expect(text).toMatch(/next one/i);
    expect(text).not.toMatch(/swaps/i);
  });

  it('confirm resets to event intake: clears event slots, keeps durable facts, retires the old plan', async () => {
    loadV3State.mockResolvedValue({
      ...initialV3State(null),
      phase: 'complete',
      committed: true,
      slots: { ...completeSlots(), goal_race: sv('CIM'), target_time: sv(14400) },
      asked: ['goal_type', 'goal_distance', 'experience_tier'],
    } as V3OnboardingState);

    await handleV3Callback(cbCtx('cbconfirm'), athlete, 'v3:next_event:confirm');

    expect(supersedeActiveTemplatePlan).toHaveBeenCalledWith('ath-1');
    const saved = saveV3State.mock.calls.at(-1)?.[1] as V3OnboardingState;
    expect(saved.phase).toBe('intake');
    expect(saved.committed).toBe(false);
    // event slots cleared
    expect(saved.slots.goal_type?.value).toBeNull();
    expect(saved.slots.goal_race?.value).toBeNull();
    expect(saved.slots.target_time?.value).toBeNull();
    // durable facts kept (no re-asking experience / days / long-run day)
    expect(saved.slots.experience_tier?.value).toBe('some_training');
    expect(saved.slots.days_per_week?.value).toBe(4);
    expect(saved.slots.long_run_day?.value).toBe(0);
    // event slots dropped from `asked` so the engine re-asks them; durable stays
    expect(saved.asked).not.toContain('goal_type');
    expect(saved.asked).toContain('experience_tier');
    // re-intake opener
    expect(sendMessage).toHaveBeenCalledWith(99, expect.stringMatching(/next event/i), expect.anything());
  });

  it('cancel leaves state and the plan untouched', async () => {
    await handleV3Callback(cbCtx('cbcancel'), athlete, 'v3:next_event:cancel');

    expect(saveV3State).not.toHaveBeenCalled();
    expect(supersedeActiveTemplatePlan).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      99,
      expect.stringMatching(/nothing's changed/i),
      expect.anything(),
    );
  });
});
