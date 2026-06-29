import { describe, it, expect, vi } from 'vitest';

// The module under test exports the pure prompt builders alongside the API
// caller; stub the client factories so importing it never needs env/network.
vi.mock('@/lib/anthropic', () => ({ anthropicClient: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));

import {
  buildSystemPrompt,
  summarizeState,
  ExtractAdvanceSchema,
  callExtractAndAdvance,
} from '../extract-and-advance';
import { anthropicClient } from '@/lib/anthropic';
import { initialV3State, type V3OnboardingState } from '../../slots/slot-state';
import type { SlotState } from '../../slots/schema';
import type { Provenance, SlotValue } from '../../slots/provenance';

function sv<const T>(value: T, provenance: Provenance = 'stated'): SlotValue<T> {
  return { value, provenance, confirmed: true };
}

function stateWith(slots: SlotState, over: Partial<V3OnboardingState> = {}): V3OnboardingState {
  return { ...initialV3State(null), phase: 'intake', slots, ...over };
}

describe('summarizeState — reflection + intents lines (R2)', () => {
  it('says the reflection is owed while the athlete is unreflected', () => {
    expect(summarizeState(stateWith({}))).toContain('has NOT been reflected');
  });

  it('drops the line once reflected — including the grandfathered pre-R2 state', () => {
    expect(summarizeState(stateWith({}, { reflected: true }))).not.toContain(
      'has NOT been reflected',
    );
    // pre-R2 mid-flight athlete: goal content present, `reflected` undefined
    expect(summarizeState(stateWith({ goal_type: sv('race') }))).not.toContain(
      'has NOT been reflected',
    );
  });

  it('lists the captured intents so the model emits only new ones', () => {
    const s = summarizeState(
      stateWith({}, { intents: ['speed at shorter distances', 'build strength'] }),
    );
    expect(s).toContain('Intents already captured');
    expect(s).toContain('"speed at shorter distances", "build strength"');
  });

  it('omits the intents line when none are captured', () => {
    expect(summarizeState(stateWith({}))).not.toContain('Intents already captured');
  });
});

describe('ExtractAdvanceSchema — lenient intents parse (R2)', () => {
  const base = { fills: [], next_action: 'ask', message: 'm' };

  it('filters non-string entries instead of failing the whole tool call', () => {
    const parsed = ExtractAdvanceSchema.parse({
      ...base,
      intents: ['get faster', 42, null, 'stay healthy'],
    });
    expect(parsed.intents).toEqual(['get faster', 'stay healthy']);
  });

  it('defaults intents to [] and reflection to null when absent', () => {
    const parsed = ExtractAdvanceSchema.parse(base);
    expect(parsed.intents).toEqual([]);
    expect(parsed.reflection).toBeNull();
  });
});

describe('ExtractAdvanceSchema — fills normalization (the "Lost the thread" fix)', () => {
  const base = { next_action: 'ask', message: 'm' };

  it('keeps valid-slot fills untouched', () => {
    const parsed = ExtractAdvanceSchema.parse({
      ...base,
      fills: [{ slot: 'goal_type', value: 'race', provenance: 'stated' }],
    });
    expect(parsed.fills).toEqual([{ slot: 'goal_type', value: 'race', provenance: 'stated' }]);
  });

  it('hoists a misfiled goal_distance_mi out of fills instead of failing the call', () => {
    // The exact shape that caused the fallback: the model dropped goal_distance_mi (a
    // top-level field, not a slot) into `fills` on the off-catalog-distance path. The
    // static enum used to fail the whole tool call → the retry loop → "Lost the thread".
    const parsed = ExtractAdvanceSchema.parse({
      ...base,
      fills: [
        { slot: 'goal_type', value: 'race', provenance: 'inferred' },
        { slot: 'goal_distance_mi', value: 44, provenance: 'stated' },
      ],
    });
    expect(parsed.fills).toEqual([{ slot: 'goal_type', value: 'race', provenance: 'inferred' }]);
    expect(parsed.goal_distance_mi).toBe(44);
  });

  it('hoists a misfiled goal_pace_sec_per_mi out of fills', () => {
    const parsed = ExtractAdvanceSchema.parse({
      ...base,
      fills: [{ slot: 'goal_pace_sec_per_mi', value: 600, provenance: 'stated' }],
    });
    expect(parsed.fills).toEqual([]);
    expect(parsed.goal_pace_sec_per_mi).toBe(600);
  });

  it('does not overwrite a top-level numeric field already set by the model', () => {
    const parsed = ExtractAdvanceSchema.parse({
      ...base,
      goal_distance_mi: 50,
      fills: [{ slot: 'goal_distance_mi', value: 44, provenance: 'stated' }],
    });
    expect(parsed.goal_distance_mi).toBe(50);
  });

  it('drops an unknown slot key without failing, and a bad provenance falls to inferred', () => {
    const parsed = ExtractAdvanceSchema.parse({
      ...base,
      fills: [
        { slot: 'not_a_slot', value: 'x', provenance: 'stated' },
        { slot: 'goal_distance', value: 'marathon', provenance: 'whoops' },
      ],
    });
    expect(parsed.fills).toEqual([
      { slot: 'goal_distance', value: 'marathon', provenance: 'inferred' },
    ]);
  });

  it('skips a wholly malformed fill entry (not even an object)', () => {
    const parsed = ExtractAdvanceSchema.parse({
      ...base,
      fills: ['garbage', 42, { slot: 'goal_type', value: 'race', provenance: 'stated' }],
    });
    expect(parsed.fills).toEqual([{ slot: 'goal_type', value: 'race', provenance: 'stated' }]);
  });
});

describe('ExtractAdvanceSchema — volume_goal (staging fix)', () => {
  const base = { fills: [], next_action: 'ask', message: 'm' };

  it('parses a valid volume goal', () => {
    const parsed = ExtractAdvanceSchema.parse({
      ...base,
      volume_goal: { miles: 100, period: 'month' },
    });
    expect(parsed.volume_goal).toEqual({ miles: 100, period: 'month' });
  });

  it('a junk shape parses to null instead of failing the tool call', () => {
    const parsed = ExtractAdvanceSchema.parse({
      ...base,
      volume_goal: { miles: 'lots', period: 'fortnight' },
    });
    expect(parsed.volume_goal).toBeNull();
  });

  it('defaults to null when absent', () => {
    expect(ExtractAdvanceSchema.parse(base).volume_goal).toBeNull();
  });
});

describe('callExtractAndAdvance — prompt caching on the static prefix', () => {
  function toolResponse(usage: Record<string, number>) {
    return {
      content: [{ type: 'tool_use', input: { fills: [], next_action: 'ask', message: 'hi' } }],
      usage,
    };
  }

  function input() {
    return { state: initialV3State(null), history: [], latest: 'hi', athleteId: 'a' };
  }

  it('marks the system block ephemeral and surfaces a cache read on the warm call', async () => {
    const create = vi.fn();
    // First call writes the prefix; the second (inside the TTL) reads it.
    create.mockResolvedValueOnce(
      toolResponse({ input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 3000 }),
    );
    create.mockResolvedValueOnce(
      toolResponse({ input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 3000 }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(anthropicClient).mockReturnValue({ messages: { create } } as any);

    const cold = await callExtractAndAdvance(input());
    const warm = await callExtractAndAdvance(input());

    // The static prefix is sent as a cache-controlled block, not a plain string.
    const sys = create.mock.calls[0]![0].system;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' });

    // Cold call writes the cache; warm call reads it (the DoD assertion).
    expect(cold.cacheCreationTokens).toBeGreaterThan(0);
    expect(warm.cacheReadTokens).toBeGreaterThan(0);
  });
});

describe('system prompt — the staging-fix rules are pinned', () => {
  const prompt = buildSystemPrompt();

  it('marks the short side of the catalog (the mile enum-bypass)', () => {
    expect(prompt).toContain('"a mile" (goal_distance_mi: 1)');
    expect(prompt).toContain(
      'Never map a stated distance to the nearest bucket in either direction',
    );
  });

  it('requires a stated time goal to land as a target_time fill on the same turn', () => {
    expect(prompt).toContain('target_time fill on that same turn');
  });

  it('routes periodic mileage targets to volume_goal and forbids promising them', () => {
    expect(prompt).toContain('emit it as volume_goal');
    expect(prompt).toContain('never promise the schedule will hit it');
  });
});
