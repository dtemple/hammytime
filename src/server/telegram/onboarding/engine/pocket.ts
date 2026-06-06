// Onboarding v3 (V3-W8): the uncatalogued-goal pocket (ONBOARDING_V3 §5.2).
//
// When a goal lands outside the current catalog — an oversize race distance, a
// non-race objective the bucket model can't hold — the engine fails HONESTLY
// instead of forcing the nearest enum literal (the strand-and-loop the 2026-06-05
// transcripts hit). Detection is a code state, never a model guess: a confirmed
// race's distance_mi past the bands (router.resolveRace) or a stated distance the
// model surfaced as `goal_distance_mi` (applyStatedDistance) sets the pocket. The
// engine then acknowledges plainly, offers the nearest in-catalog structure
// (`proxy`) with consent, and — on accept — carries the athlete's own words to
// commit so the daily coach knows the real target behind the proxy plan.
//
// These are pure functions; the router wires them and talks to Telegram.

import { slotValue } from '../slots/provenance';
import type { GoalDistanceValue } from '../slots/schema';
import type { OutOfCatalogGoal, V3OnboardingState } from '../slots/slot-state';
import { deriveBucketFromMiles } from './numeric';
import type { Chip, ExtractAdvanceOutput } from './extract-and-advance';
import { enforceGuardrails, mergeFills, type ResolvedTurn } from './guardrails';

/** The nearest in-catalog structure today — the largest bucket. ULTRA_SUPPORT U1
 *  widens the catalog underneath this and the proxy graduates to a real ultra plan. */
const PROXY: GoalDistanceValue = 'marathon';

/** The consent chips on every pocket turn (a closed 2-option set → chips, per
 *  principle 2). `yes`/`no` are the exact tokens the router fast path keys on. */
export const POCKET_CHIPS: Chip[] = [
  { label: 'Do that', value: 'yes' },
  { label: 'Not now', value: 'no' },
];

/** The acknowledge + offer body. Daybreak voice, no hedging. The caller may
 *  prepend race context ("Found it — Western States, June 28. Heads up though: …"). */
export function pocketBody(distanceMi: number | null): string {
  const lead = distanceMi != null ? `${Math.round(distanceMi)} miles is` : "That's";
  const target = distanceMi != null ? 'it' : 'your goal';
  return `${lead} past what I can build a structured plan for right now — I top out at the marathon. What I can do is build you a strong marathon block and point you at ${target} as the target. Want that?`;
}

/** Mark the goal `out_of_catalog`, consent pending. */
export function setPocket(
  state: V3OnboardingState,
  words: string,
  distanceMi: number | null,
): V3OnboardingState {
  const out: OutOfCatalogGoal = {
    words,
    distance_mi: distanceMi,
    proxy: PROXY,
    consent: 'pending',
  };
  return { ...state, out_of_catalog: out };
}

export interface StatedDistanceResult {
  state: V3OnboardingState;
  /** True when the distance is out of catalog and the turn became a pocket offer. */
  pocket: boolean;
  /** The pocket message + chips (only when `pocket`); empty otherwise. */
  message: string;
  chips: Chip[];
}

/**
 * Bucket a distance the athlete STATED (no race lookup) — Chase's "44 miles" case.
 * In range → set `goal_distance` in code (stated; the athlete said it), so the
 * model never maps a number to a bucket. Out of range → open the pocket.
 */
export function applyStatedDistance(
  state: V3OnboardingState,
  miles: number,
  words: string,
): StatedDistanceResult {
  const bucket = deriveBucketFromMiles(miles);
  if (bucket) {
    const slots = { ...state.slots, goal_distance: slotValue(bucket, 'stated', true) };
    return { state: { ...state, slots }, pocket: false, message: '', chips: [] };
  }
  return {
    state: setPocket(state, words, miles),
    pocket: true,
    message: pocketBody(miles),
    chips: POCKET_CHIPS,
  };
}

const SYNTHETIC_GENERATE: ExtractAdvanceOutput = {
  fills: [],
  next_action: 'generate',
  message: '',
  chips: [],
  asked_slot: null,
  race_lookup_query: null,
  goal_distance_mi: null,
  contradiction: null,
  numeric_unresolved: null,
};

/**
 * Accept the marathon-proxy (the `yes` chip): write `goal_distance` = proxy
 * (stated, so it skips the inferred-confirm gate), record consent, then re-run the
 * generate gate so the flow advances to its next move (confirm/recap/generate).
 * The athlete's `words` ride in `out_of_catalog` to commit. Caller guarantees the
 * pocket is set.
 */
export function acceptPocketAndAdvance(state: V3OnboardingState): ResolvedTurn {
  const pocket = state.out_of_catalog!;
  const slots = mergeFills(state.slots, [
    { slot: 'goal_distance', value: pocket.proxy, provenance: 'stated' },
  ]);
  const accepted: V3OnboardingState = {
    ...state,
    slots,
    out_of_catalog: { ...pocket, consent: 'accepted' },
  };
  return enforceGuardrails(accepted, SYNTHETIC_GENERATE);
}

/**
 * Decline the proxy (the `no` chip → re-offer / leave open). Clear the pocket and
 * the goal slots it was built from, so the goal starts fresh and the open-required
 * gate re-asks; the athlete names something in-catalog (or stays fit) next.
 */
export function declinePocket(state: V3OnboardingState): {
  state: V3OnboardingState;
  message: string;
  chips: Chip[];
} {
  const slots = { ...state.slots };
  delete slots.goal_race;
  delete slots.goal_date;
  delete slots.goal_distance;
  return {
    state: { ...state, slots, out_of_catalog: undefined },
    message:
      'No problem — want to aim at something I can build a full plan for? A marathon or shorter, or just staying fit.',
    chips: [],
  };
}

/**
 * Reconcile a pending pocket after a TYPED turn ran through the model (the chip
 * path resolves in code; this covers "yeah do that" / "nah, make it a marathon").
 * If the model filled `goal_distance` with the proxy → consent accepted; with a
 * different in-catalog distance → the athlete pivoted, drop the pocket; still open
 * → leave it pending (the generate gate keeps blocking on the open distance).
 */
export function reconcilePocket(
  prev: OutOfCatalogGoal,
  working: V3OnboardingState,
): V3OnboardingState {
  const gd = working.slots.goal_distance;
  const filled = !!gd && gd.value != null && gd.provenance !== 'unknown';
  if (!filled) return working;
  if (gd!.value === prev.proxy) {
    return { ...working, out_of_catalog: { ...prev, consent: 'accepted' } };
  }
  return { ...working, out_of_catalog: undefined };
}
