import { describe, it, expect, vi } from 'vitest';

// The module under test exports the pure prompt builders alongside the API
// caller; stub the client factories so importing it never needs env/network.
vi.mock('@/lib/anthropic', () => ({ anthropicClient: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));

import { buildSystemPrompt, summarizeState, ExtractAdvanceSchema } from '../extract-and-advance';
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
