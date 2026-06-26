// V4-W6 — the eval entry. Runs every registered fixture through the REAL engine
// (handleV3Message / handleV3Callback → the real callExtractAndAdvance against
// live Sonnet) with all I/O stubbed, scores each against the deterministic gate,
// and writes the scorecard.
//
// The vi.mock block is copied from `engine/__tests__/router.test.ts` — at this
// directory depth (engine/__evals__) the relative paths are byte-identical, by
// design (see V4_W6_PROMPT.md). The two deltas from router.test.ts:
//   - callExtractAndAdvance is the REAL import, wrapped to record each turn;
//   - loadV3State/saveV3State are backed by an in-memory store.
//
// Run with: `npm run eval` (excluded from `npm test`'s *.test.ts glob).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// --- shared, hoisted state the mocks + the driver read (vi.hoisted runs before
//     the vi.mock factories, so they can close over this). ---
const H = vi.hoisted(() => ({
  recorded: {
    commitSlots: 0,
    generateAndPersistPlan: 0,
    grantSignupCredit: 0,
    enterDormant: [] as Array<[string, string | null]>,
    setCheckBack: [] as Array<[string, string | null]>,
    exitDormant: 0,
    sendDavidAlert: 0,
    lookupRace: [] as string[],
  },
  sentMessages: [] as Array<[number | string, string, unknown]>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelTurns: [] as any[],
  history: [] as Array<{ direction: 'in' | 'out'; body: string }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stateStore: new Map<string, any>(),
  // The active fixture's frozen race table, swapped in before each drive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref: { currentRaceLookup: {} as Record<string, any> },
}));

// --- boundary mocks (byte-identical paths to router.test.ts) ---

vi.mock('../../../bot', () => ({
  botApiForChat: () => ({
    sendMessage: async (chatId: number | string, text: string, opts?: unknown) => {
      H.sentMessages.push([chatId, text, opts]);
    },
    sendChatAction: async () => undefined,
  }),
}));

vi.mock('@/lib/db', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: async () => ({ error: null }),
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: { name: 'Test' } }) }),
      }),
    }),
  }),
}));

vi.mock('../typing', () => ({
  withTyping: (_c: unknown, fn: () => Promise<unknown>) => fn(),
}));

// Feed the real model prior turns. loadRecentHistory drops the trailing inbound
// (the driver pushes it before the handler runs); the engine passes the current
// message as `latest` separately.
vi.mock('../history', () => ({
  loadRecentHistory: async (_athleteId: string, n = 8) => H.history.slice(0, -1).slice(-n),
}));

vi.mock('../../dispatcher', () => ({
  selectionKeyboardFromTap: () => null,
  labelForTap: () => 'Looks right',
}));

vi.mock('@/server/agent/race-lookup', () => ({
  lookupRace: async (query: string) => {
    H.recorded.lookupRace.push(query);
    const q = String(query).toLowerCase();
    for (const [key, res] of Object.entries(H.ref.currentRaceLookup)) {
      if (q.includes(key)) return res;
    }
    return { ok: false, reason: 'not_found' };
  },
}));

vi.mock('@/server/admin/alerts', () => ({
  sendDavidAlert: async () => {
    H.recorded.sendDavidAlert++;
  },
}));

vi.mock('../commit', () => ({
  commitSlots: async () => {
    H.recorded.commitSlots++;
  },
}));

vi.mock('../../plan-gen', () => ({
  generateAndPersistPlan: async () => {
    H.recorded.generateAndPersistPlan++;
    return { planId: 'p', versionId: 'v', plan: {}, params: {} };
  },
  supersedeActiveTemplatePlan: async () => true,
}));

vi.mock('../../steps/04-plan-preview', () => ({ formatPreview: () => 'YOUR PLAN' }));

vi.mock('@/server/billing/credits', () => ({
  grantSignupCredit: async () => {
    H.recorded.grantSignupCredit++;
    return true;
  },
}));

vi.mock('../../../pause', () => ({
  enterDormant: async (id: string, at: string | null) => {
    H.recorded.enterDormant.push([id, at]);
  },
  exitDormant: async () => {
    H.recorded.exitDormant++;
    return false;
  },
  setCheckBack: async (id: string, at: string | null) => {
    H.recorded.setCheckBack.push([id, at]);
  },
}));

// Partial mock: keep the real pure parse/render, stub the DB read/write.
vi.mock('../../known-gaps-memory', async (orig) => ({
  ...(await orig<typeof import('../../known-gaps-memory')>()),
  loadKnownGapsContent: async () => '',
  seedKnownGapsFromFilled: async () => undefined,
}));

// Partial mock: keep the real pure helpers (initialV3State, hasReflected,
// isV3OnboardingComplete used by the real guardrails); back load/save with the
// in-memory store.
vi.mock('../../slots/slot-state', async (orig) => ({
  ...(await orig<typeof import('../../slots/slot-state')>()),
  loadV3State: async (id: string) => H.stateStore.get(id) ?? null,
  saveV3State: async (id: string, st: unknown) => {
    H.stateStore.set(id, st);
  },
}));

// The ONE real model call, wrapped to capture each turn's output + token usage.
vi.mock('../extract-and-advance', async (orig) => {
  const actual = await orig<typeof import('../extract-and-advance')>();
  return {
    ...actual,
    callExtractAndAdvance: async (input: Parameters<typeof actual.callExtractAndAdvance>[0]) => {
      const r = await actual.callExtractAndAdvance(input);
      H.modelTurns.push({
        fills: r.output.fills,
        next_action: r.output.next_action,
        message: r.output.message,
        chips: r.output.chips,
        contradiction: r.output.contradiction,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        cacheReadTokens: r.cacheReadTokens,
      });
      return r;
    },
    logOnboardingRun: async () => undefined,
  };
});

import { driveFixture } from './drive';
import { checkExpectations, checkGlobalInvariants } from './assertions';
import { writeScorecard } from './scorecard';
import { judgeEnabled, judgeVoice } from './judge';
import { fixtures } from './fixtures';
import type { DriveResult, HarnessPorts } from './types';

const ports: HarnessPorts = {
  sentMessages: H.sentMessages,
  recorded: H.recorded,
  modelTurns: H.modelTurns,
  history: H.history,
  stateStore: H.stateStore,
  reset: () => {
    H.sentMessages.length = 0;
    H.modelTurns.length = 0;
    H.history.length = 0;
    H.stateStore.clear();
    H.recorded.commitSlots = 0;
    H.recorded.generateAndPersistPlan = 0;
    H.recorded.grantSignupCredit = 0;
    H.recorded.enterDormant.length = 0;
    H.recorded.setCheckBack.length = 0;
    H.recorded.exitDormant = 0;
    H.recorded.sendDavidAlert = 0;
    H.recorded.lookupRace.length = 0;
  },
};

const results: DriveResult[] = [];

beforeAll(async () => {
  const judge = judgeEnabled();
  for (const fx of fixtures) {
    H.ref.currentRaceLookup = fx.raceLookup ?? {};
    const r = await driveFixture(fx, ports);
    // Deterministic gate first — the judge never touches pass/fail.
    r.failures = [...checkExpectations(r), ...checkGlobalInvariants(r, fx)];
    if (judge) {
      const v = await judgeVoice(r);
      r.voice = { score: v.score, note: v.note };
      r.costUsd += v.costUsd; // fold the Opus pass into the spend readout
    }
    results.push(r);
  }
}, 1000 * 60 * Math.max(5, fixtures.length * 3));

describe('onboarding eval (live Sonnet)', () => {
  for (const fx of fixtures) {
    it(fx.name, () => {
      const r = results.find((x) => x.fixture.name === fx.name);
      expect(r, `fixture ${fx.name} did not run`).toBeDefined();
      if (r!.fixture.knownFlaky) return; // surfaced in the scorecard, not gated
      expect(r!.failures, r!.failures.join('\n') || 'ok').toEqual([]);
    });
  }
});

afterAll(() => {
  if (!results.length) return;
  const { path, card } = writeScorecard(results);
  // eslint-disable-next-line no-console
  console.log(
    `\n[eval] scorecard: ${path}\n[eval] spend: $${card.totalCost.toFixed(4)}  cache hit: ${(card.cacheHitRate * 100).toFixed(1)}%`,
  );
});
