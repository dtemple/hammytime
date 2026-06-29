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
import { SLOT_CHIPS, INJURY_CHIPS } from '../../slots/chips';
import { coerceFill } from '../guardrails';
import type { Chip } from '../extract-and-advance';
import type { DriveResult } from './types';

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
export function checkGlobalInvariants(result: DriveResult): string[] {
  const out: string[] = [];
  const s = result.finalState;

  // 1. The injury beat must be SURFACED before any commit. Under soft-via-open
  //    (ONBOARDING_CHIPS §6) the athlete may dodge — leaving injury_status open —
  //    so the gate is satisfied by an answer OR by the beat having been asked. The
  //    invariant is the safety floor: never commit without giving them the chance.
  if (result.ports.commitSlots > 0 || result.ports.generateAndPersistPlan > 0) {
    const answered = s.slots.injury_status?.value != null;
    const asked = s.asked.includes('injury_status');
    if (!answered && !asked)
      out.push('invariant[injury-beat]: committed/generated without ever asking the injury beat');
  }

  // 2. No generate reached commit with a required-core slot still open.
  if (result.ports.generateAndPersistPlan > 0) {
    const goalType = (s.slots.goal_type?.value as GoalTypeValue | null) ?? null;
    const open = requiredCoreSlots(goalType).filter((k) => !isFilled(s.slots[k]));
    if (open.length)
      out.push(`invariant[no-open-core-at-generate]: generated with open core slots ${JSON.stringify(open)}`);
  }

  // (The §9 "no stated provenance for an unstated value" check is intentionally NOT
  // a deterministic invariant: a facts-substring match false-positives on
  // model-resolved dates ("September" → the 15th), looked-up race dates, composed
  // goal labels, and "nothing" → "none" normalizations — all faithful, not invented.
  // Fabrication is a qualitative judge dimension, Part 5.)

  // 3. The orientation sentence appears exactly once across all coach messages.
  const orientationCount = result.transcript.filter(
    (t) => t.direction === 'coach' && t.body.includes(ORIENTATION_SENTENCE),
  ).length;
  if (orientationCount > 1)
    out.push(`invariant[orientation-once]: orientation sentence appeared ${orientationCount} times`);

  // 4. The chip policy (ONBOARDING_CHIPS §4 / §5.3) — the regression net for the
  //    §5.1/§5.2 fixes. Folded in here so it runs on every fixture.
  out.push(...checkChipPolicy(result));

  return out;
}

// ---------------------------------------------------------------------------
// Chip linter (ONBOARDING_CHIPS §5.3)
// ---------------------------------------------------------------------------
//
// The four §4 corollaries, asserted against the rendered transcript — what the
// athlete actually saw, regardless of which source (code-owned §5.1 or
// model-owned §5.2) produced the chips. Deterministic by design: no model calls.
//
// Scope: only the onboarding *chips* — the buttons whose tap replays the chip's
// value back as athlete text. Those ship with the `v3:` callback prefix
// (router.ts CHIP_PREFIX). The post-plan next-actions keyboard (`next:`) and any
// other inline keyboard are not chips in the policy sense and are left alone.

const CHIP_PREFIX = 'v3:';

// A confirmation tell: the message states a value back and asks the athlete to
// verify it ("…that right?", "…match?") rather than asking openly ("how would you
// describe yourself?"). §3.2 is option chips landing on one of THESE — so the
// regex must catch the confirm phrasings without matching the open asks that
// legitimately carry option chips (the goal / distance / experience questions).
const CONFIRM_TELL =
  /\b(that('?s| is)? right|about right|looks? right|sounds? (right|good|ok|okay)|that match|matches\b|correct|that works?( for you)?)\?/i;

// Affirm/decline vocabulary (chip VALUES, post-prefix). A set drawn only from
// these is a yes/no set — the legitimate companion to a confirmation tell (Looks
// right / Fix it → yes / let me fix that; That works / Not quite). Anything else
// on a confirm tell is an option set (§3.2).
const YES_NO_VALUES = new Set([
  'yes',
  'yeah',
  'yep',
  'y',
  'sure',
  'ok',
  'okay',
  'looks right',
  'that works',
  'sounds right',
  'sounds good',
  'correct',
  'no',
  'nope',
  'n',
  'let me fix that',
  'fix it',
  'not quite',
]);

// The app-guaranteed option sets (chips.ts), used by the round-trip check. Match a
// rendered set by label, then verify the VALUE behind each label still reaches the
// slot it answers. Enum-literal sets coerce straight through coerceFill; the prose
// sets (goal_type, the injury beat) round-trip via the model, so the linter checks
// them by exact match against the canonical value instead.
const APP_GUARANTEED_SETS: ReadonlyArray<{
  slot: SlotKey;
  chips: readonly Chip[];
  coercible: boolean;
}> = [
  { slot: 'goal_type', chips: SLOT_CHIPS.goal_type ?? [], coercible: false },
  { slot: 'goal_distance', chips: SLOT_CHIPS.goal_distance ?? [], coercible: true },
  { slot: 'experience_tier', chips: SLOT_CHIPS.experience_tier ?? [], coercible: true },
  { slot: 'injury_status', chips: INJURY_CHIPS, coercible: false },
];

/**
 * A non-soliciting turn — a goodbye, an off-ramp farewell, or a reflection-only
 * mirror (§3.3) — which must carry no chips. Deliberately NARROW: a bare "no '?'"
 * test over-fires on the legitimate chipped turns that state rather than ask — an
 * imperative ask ("Go check the site and let me know.") and a recap that closes on
 * a statement ("…building your plan now.") + the Looks right / Fix it set. Those
 * solicit a reply, so chips belong; only true sign-offs and pure mirrors don't.
 */
function isNonSoliciting(body: string): boolean {
  const t = body.trim();
  if (t.length === 0) return true;
  // Emoji / punctuation only — the 👋😄 goodbye that re-rendered the goal chips.
  if (!/[a-z]/i.test(t)) return true;
  // A reflection-only mirror: its signature opener, with no ask of its own. (A
  // recap opens "Here's what I've got" — different — and is a solicit, so excluded.)
  if (/here'?s what i'?m hearing/i.test(t) && !t.includes('?')) return true;
  // A farewell sign-off that asks nothing. Gated on no '?' so the off-ramp's
  // check-back offer ("…check back when something lands?" + interval chips) — a
  // real question — is untouched.
  if (
    !t.includes('?') &&
    /\b(leave it (here|there)|talk soon|take care|catch you (later|around)|whenever (something|anything) (lands|comes up|might be)|message me (then|when))\b/i.test(
      t,
    )
  )
    return true;
  return false;
}

/** The first value that repeats in a list (case-insensitive), or null. */
function firstDuplicate(xs: string[]): string | null {
  const seen = new Set<string>();
  for (const x of xs) {
    const k = x.toLowerCase().trim();
    if (seen.has(k)) return x;
    seen.add(k);
  }
  return null;
}

/** The app-guaranteed set a rendered chip turn answers, by best label overlap
 *  (labels are distinctive, so one match is enough). null = model chips for an
 *  open ask, which carry no fixed slot to round-trip against. */
function recognizeAppSet(labels: string[]): (typeof APP_GUARANTEED_SETS)[number] | null {
  let best: (typeof APP_GUARANTEED_SETS)[number] | null = null;
  let bestMatches = 0;
  for (const set of APP_GUARANTEED_SETS) {
    const setLabels = new Set(set.chips.map((c) => c.label));
    const matches = labels.filter((l) => setLabels.has(l)).length;
    if (matches > bestMatches) {
      best = set;
      bestMatches = matches;
    }
  }
  return bestMatches > 0 ? best : null;
}

/**
 * The §5.3 chip assertions, run per coach turn over the rendered transcript.
 * Mirrors the §4 corollaries one-to-one:
 *   1. no chips on a non-question / terminal turn (§3.3);
 *   2. no same-outcome pair (§3.1);
 *   3. no option chips on a yes/no-phrased confirm (§3.2);
 *   4. an app-guaranteed set's values must round-trip to the slot it asks.
 */
export function checkChipPolicy(result: DriveResult): string[] {
  const out: string[] = [];

  result.transcript.forEach((turn, i) => {
    if (turn.direction !== 'coach') return;
    const chips = (turn.chips ?? []).filter((c) => c.data.startsWith(CHIP_PREFIX));
    if (chips.length === 0) return;

    const labels = chips.map((c) => c.label);
    const values = chips.map((c) => c.data.slice(CHIP_PREFIX.length));
    const where = `coach turn ${i}`;
    const set = `[${labels.join(' | ')}]`;

    // (1) §3.3 — chips on a non-soliciting turn: a goodbye, an off-ramp farewell,
    //     or a reflection-only mirror. A statement-form ask or a recap still
    //     solicits a reply, so those keep their chips (see isNonSoliciting).
    if (isNonSoliciting(turn.body)) {
      out.push(`chip-policy[non-question]: ${where} carries chips ${set} on a non-soliciting turn`);
    }

    // (2) §3.1 — a same-outcome pair: two chips that replay to the same value, or
    //     show the same label, are one choice, not two.
    const dupValue = firstDuplicate(values);
    const dupLabel = firstDuplicate(labels);
    if (dupValue) {
      out.push(`chip-policy[same-outcome]: ${where} has two chips with the same value "${dupValue}" ${set}`);
    } else if (dupLabel) {
      out.push(`chip-policy[same-outcome]: ${where} has two chips with the same label "${dupLabel}" ${set}`);
    }

    // (3) §3.2 — option chips on a yes/no-phrased confirm. The message verifies a
    //     value ("…that right?") but the chips offer answer options for a slot.
    if (CONFIRM_TELL.test(turn.body)) {
      const allYesNo = values.every((v) => YES_NO_VALUES.has(v.toLowerCase().trim()));
      if (!allYesNo) {
        out.push(`chip-policy[option-on-yesno]: ${where} pairs a yes/no confirm with option chips ${set}`);
      }
    }

    // (4) §5.3 — a recognized app-guaranteed set whose values don't round-trip to
    //     its slot. Identify the set by label, then check each value behind it.
    const appSet = recognizeAppSet(labels);
    if (appSet) {
      const canonical = new Map(appSet.chips.map((c) => [c.label, c.value]));
      for (const c of chips) {
        const value = c.data.slice(CHIP_PREFIX.length);
        const expected = canonical.get(c.label);
        if (expected === undefined) {
          out.push(`chip-policy[round-trip]: ${where} chip "${c.label}" is not part of the ${appSet.slot} set ${set}`);
        } else if (appSet.coercible && coerceFill(appSet.slot, value) === undefined) {
          out.push(`chip-policy[round-trip]: ${where} value "${value}" (chip "${c.label}") doesn't round-trip to ${appSet.slot}`);
        } else if (!appSet.coercible && value !== expected) {
          out.push(`chip-policy[round-trip]: ${where} value "${value}" (chip "${c.label}") drifted from the canonical ${appSet.slot} value "${expected}"`);
        }
      }
    }
  });

  return out;
}
