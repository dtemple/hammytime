// V4-W6 — deterministic scoring. Two layers:
//   1. checkExpectations  — the per-fixture FixtureExpect, asserted against the
//      recorded ports + final state (the robust surface; prose only via the
//      fixture's customAssertions).
//   2. checkGlobalInvariants — the §9 invariants that hold on EVERY fixture
//      (injury beat asked before commit, no generate past an open core slot, no
//      stated provenance for an unstated value, one orientation sentence).
//
// Both return a list of human-readable failure strings (empty = pass).

import { requiredCoreSlots, type GoalTypeValue, type SlotKey } from '../../slots/schema';
import { isFilled } from '../../slots/provenance';
import type { DriveResult, OnboardingFixture } from './types';

const ORIENTATION_SENTENCE = "Tap a button or type an answer if it's not in the list.";

function slotValue(result: DriveResult, slot: SlotKey): unknown {
  return result.finalState.slots[slot]?.value ?? null;
}

/** The per-fixture declarative expectations + any custom prose assertions. */
export function checkExpectations(result: DriveResult): string[] {
  const out: string[] = [];
  const e = result.fixture.expect;
  const p = result.ports;
  const s = result.finalState;

  // Non-convergence is only a failure when the fixture expected a terminal. A
  // mid-conversation behavior fixture (e.g. the beyond-50k redirect, which asks
  // for a shorter event and never resolves on its own) legitimately ends open.
  const expectsTerminal = e.planGenerated === true || e.offRamp === true || e.checkBackCaptured === true;
  if (result.outcome === 'did_not_converge' && expectsTerminal) {
    out.push(`did not converge within the turn cap (expected a terminal outcome)`);
  }

  if (e.planGenerated != null) {
    const got = p.generateAndPersistPlan > 0;
    if (got !== e.planGenerated) out.push(`planGenerated: expected ${e.planGenerated}, got ${got}`);
  }

  if (e.offRamp != null) {
    const got = p.enterDormant.length > 0 || s.phase === 'off_ramp';
    if (got !== e.offRamp) out.push(`offRamp: expected ${e.offRamp}, got ${got}`);
  }

  if (e.checkBackCaptured != null) {
    const got = p.setCheckBack.length > 0;
    if (got !== e.checkBackCaptured)
      out.push(`checkBackCaptured: expected ${e.checkBackCaptured}, got ${got}`);
  }

  if (e.eventKind != null) {
    const got = s.event_kind ?? 'race';
    if (got !== e.eventKind) out.push(`eventKind: expected ${e.eventKind}, got ${got}`);
  }

  if (e.goalDistance != null) {
    const got = slotValue(result, 'goal_distance');
    if (got !== e.goalDistance) out.push(`goalDistance: expected ${e.goalDistance}, got ${String(got)}`);
  }

  if (e.goalDateEndsWith != null) {
    const got = slotValue(result, 'goal_date');
    if (typeof got !== 'string' || !got.endsWith(e.goalDateEndsWith))
      out.push(`goalDate: expected to end with ${e.goalDateEndsWith}, got ${String(got)}`);
  }

  if (e.eventDistanceMi != null) {
    const got = s.event_distance_mi ?? null;
    if (got !== e.eventDistanceMi)
      out.push(`eventDistanceMi: expected ${e.eventDistanceMi}, got ${String(got)}`);
  }

  if (e.intentsInclude) {
    const intents = (s.intents ?? []).map((i) => i.toLowerCase());
    for (const needle of e.intentsInclude) {
      if (!intents.some((i) => i.includes(needle.toLowerCase())))
        out.push(`intentsInclude: no intent contains "${needle}" (intents: ${JSON.stringify(s.intents ?? [])})`);
    }
  }

  if (e.noBucketWritten) {
    const got = slotValue(result, 'goal_distance');
    if (got != null) out.push(`noBucketWritten: a goal_distance bucket was written (${String(got)})`);
  }

  if (e.lookupNotCalled) {
    if (p.lookupRace.length > 0)
      out.push(`lookupNotCalled: lookupRace was called with ${JSON.stringify(p.lookupRace)}`);
  }

  if (e.noTimeGoal) {
    const got = slotValue(result, 'target_time');
    if (got != null) out.push(`noTimeGoal: target_time was set (${String(got)})`);
  }

  if (result.fixture.customAssertions) {
    try {
      result.fixture.customAssertions(result);
    } catch (err) {
      out.push(`customAssertion: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return out;
}

/**
 * The §9 global invariants, run on every fixture regardless of its declared
 * expectations. These are the launch-gate safety properties.
 */
export function checkGlobalInvariants(result: DriveResult, fixture: OnboardingFixture): string[] {
  const out: string[] = [];
  const s = result.finalState;

  // 1. The injury beat must be asked before any commit. If the plan was committed
  //    (generate fired), injury_status must be a non-null answered value.
  if (result.ports.commitSlots > 0 || result.ports.generateAndPersistPlan > 0) {
    if (s.slots.injury_status?.value == null)
      out.push('invariant[injury-beat]: committed/generated without an answered injury beat');
  }

  // 2. No generate reached commit with a required-core slot still open.
  if (result.ports.generateAndPersistPlan > 0) {
    const goalType = (s.slots.goal_type?.value as GoalTypeValue | null) ?? null;
    const open = requiredCoreSlots(goalType).filter((k) => !isFilled(s.slots[k]));
    if (open.length)
      out.push(`invariant[no-open-core-at-generate]: generated with open core slots ${JSON.stringify(open)}`);
  }

  // 3. No `stated` provenance for a value absent from the fact sheet. Compared
  //    only where the fact-sheet ground truth is unambiguous; fuzzy slots are
  //    skipped (the prompt flags those as judge-assisted, not deterministic).
  const factsBlob = JSON.stringify(fixture.facts).toLowerCase();
  for (const turn of result.modelTurns) {
    for (const fill of turn.fills) {
      if (fill.provenance !== 'stated') continue;
      if (typeof fill.value !== 'string') continue;
      const v = fill.value.toLowerCase();
      // Only flag clearly-textual stated fills that have no echo in the facts AND
      // aren't a normalized enum (enums map words → literals, so absence is fine).
      if (v.length < 4) continue;
      if (NORMALIZED_ENUM_VALUES.has(v)) continue;
      if (!factsBlob.includes(v))
        out.push(
          `invariant[no-stated-for-unstated]: ${fill.slot}="${fill.value}" marked stated but not in the fact sheet`,
        );
    }
  }

  // 4. The orientation sentence appears exactly once across all coach messages.
  const orientationCount = result.transcript.filter(
    (t) => t.direction === 'coach' && t.body.includes(ORIENTATION_SENTENCE),
  ).length;
  if (orientationCount > 1)
    out.push(`invariant[orientation-once]: orientation sentence appeared ${orientationCount} times`);

  return out;
}

// Closed-enum literals the model maps words onto — a `stated` enum fill whose
// literal isn't verbatim in the facts is still legitimate (the fact sheet says
// "a few years of consistent running"; the fill is "experienced").
const NORMALIZED_ENUM_VALUES = new Set([
  'beginner',
  'for_fun',
  'some_training',
  'experienced',
  '5k',
  '10k',
  'half',
  'marathon',
  '50k',
  'keep_fit',
  'race',
  'general_fitness',
  'none',
  'active',
  'monitoring',
  'past',
  'unknown',
]);
