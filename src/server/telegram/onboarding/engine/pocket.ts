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

import { formatFinishTime } from '../parsing/durations';
import { slotValue } from '../slots/provenance';
import type { GoalDistanceValue } from '../slots/schema';
import type { OutOfCatalogGoal, V3OnboardingState } from '../slots/slot-state';
import { CATALOG_FLOOR_MI, deriveBucketFromMiles } from './numeric';
import type { Chip, ExtractAdvanceOutput } from './extract-and-advance';
import {
  enforceGuardrails,
  mergeFills,
  mergeIntents,
  SYNTHETIC_GENERATE,
  type ResolvedTurn,
} from './guardrails';

/** The nearest in-catalog structure for a pocketed goal. Since V4-W4 only the SHORT
 *  side reaches the pocket — a sub-floor goal proxies to the 5k. The long-side
 *  branch (oversize / shapeless → marathon) is retained but no longer routed to:
 *  a goal beyond the 50k takes the off-ramp (applyUltraOffRamp), not a proxy plan.
 *  Left in place, revivable — mirrors the keep_fit-retirement posture. */
function proxyFor(distanceMi: number | null): GoalDistanceValue {
  return distanceMi != null && distanceMi < CATALOG_FLOOR_MI ? '5k' : 'marathon';
}

/** The consent chips on every pocket turn (a closed 2-option set → chips, per
 *  principle 2). `yes`/`no` are the exact tokens the router fast path keys on. */
export const POCKET_CHIPS: Chip[] = [
  { label: 'Do that', value: 'yes' },
  { label: 'Not now', value: 'no' },
];

/** The consent chips when the pocket opens ON the reflection turn (R2): the
 *  decline reads as "you misread me", not "not interested" — it takes the redo
 *  path (declinePocket). Same `yes`/`no` values, so the fast path is untouched. */
export const REFLECTION_POCKET_CHIPS: Chip[] = [
  { label: 'Do that', value: 'yes' },
  { label: 'Not quite my goal', value: 'no' },
];

/** A short-race target reads as M:SS ("5:00"), not the H:MM:SS finish-time form
 *  ("0:05:00") the bucket distances use. Exported for the cross-fire backstop's
 *  pairing question (router), which echoes the cleared value the same way. */
export function formatShortTarget(seconds: number): string {
  if (seconds >= 3600) return formatFinishTime(seconds);
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

/** The acknowledge + offer body. Daybreak voice, no hedging. The caller may
 *  prepend race context ("Found it — Western States, June 28. Heads up though: …").
 *  Branches by direction: the short side (below the catalog floor) offers a 5K
 *  block; the long side keeps the marathon offer byte-for-byte. A known goal time
 *  is templated in deterministically on the short side ("treating 5:00 as the
 *  goal") — R2's smoothing, no model involved. */
export function pocketBody(distanceMi: number | null, targetTimeSec?: number | null): string {
  if (distanceMi != null && distanceMi < CATALOG_FLOOR_MI) {
    const rounded = Math.round(distanceMi);
    const race = rounded === 1 ? 'A mile race' : `A ${rounded}-mile race`;
    const pace = rounded === 1 ? 'mile-pace' : 'race-pace';
    const target = targetTimeSec != null ? formatShortTarget(targetTimeSec) : 'your target';
    return `${race} is shorter than what I build a full plan for right now — I bottom out at the 5K. What I can do: a 5K block with ${pace} work in the mix, treating ${target} as the goal the whole way. Want that?`;
  }
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
    proxy: proxyFor(distanceMi),
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
 * The beyond-50k boundary + redirect (V4-W4). The catalog tops at the 50k, so a goal
 * past it — a 44-miler, a 100k, a 100-miler — is NOT proxied down to a 50k plan: the
 * engine says so plainly and asks for a shorter event it CAN build around. v4 is
 * event-only (no keep_fit fallback), and there's no promise to reach back out when
 * 50mi+ support ships (nothing remembers to). The caller may prepend race context
 * ("Found it — Western States, June 28. …").
 */
export function ultraOffRampBody(distanceMi: number | null): string {
  const lead = distanceMi != null ? `${Math.round(distanceMi)} miles is` : "That's";
  return `${lead} past what I can build a structured plan for right now — I top out at the 50k. Is there a shorter event or a tune-up race you'd want me to build around instead? Anything from a 5K up to a 50k and we're set.`;
}

/**
 * Off-ramp a beyond-50k goal: clear the goal slots so a shorter event re-opens the
 * normal flow (the same clear-and-reopen `declinePocket` uses), and demote the
 * athlete's words to the intents so the daily coach still sees the real target. No
 * pocket, no proxy plan.
 */
export function applyUltraOffRamp(state: V3OnboardingState, words: string): V3OnboardingState {
  const slots = { ...state.slots };
  delete slots.goal_race;
  delete slots.goal_date;
  delete slots.goal_distance;
  return {
    ...state,
    slots,
    out_of_catalog: undefined,
    intents: mergeIntents(state.intents, [words]),
  };
}

/**
 * Bucket a distance the athlete STATED (no race lookup) — Chase's "44 miles" case.
 * In catalog → set `goal_distance` in code (stated; the athlete said it), so the
 * model never maps a number to a bucket. Out of catalog splits by direction: the
 * SHORT side (below the floor) opens the 5k pocket (a consented proxy); the LONG
 * side (beyond the 50k) takes the off-ramp — no proxy, ask for a shorter event.
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
  if (miles < CATALOG_FLOOR_MI) {
    // The same turn often fills target_time ("1 mile in under 5") — the caller
    // merges fills before this runs, so the slot is current here.
    const targetTime = state.slots.target_time?.value as number | null | undefined;
    return {
      state: setPocket(state, words, miles),
      pocket: true,
      message: pocketBody(miles, targetTime ?? null),
      chips: POCKET_CHIPS,
    };
  }
  // Beyond the 50k → off-ramp (no pocket, no consent chips).
  return {
    state: applyUltraOffRamp(state, words),
    pocket: false,
    message: ultraOffRampBody(miles),
    chips: [],
  };
}

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
 *
 * R2 redo: the first decline after a reflection is read as "you misread me", not
 * "not interested" — it re-arms the reflection (`reflected: false`) and asks for a
 * restatement, once (`reflection_redone`). Intents survive; they're top-level
 * state, not goal slots. After the one redo (or for a pre-R2 state), the standard
 * re-offer copy stands and the recap is the net.
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
  const redo = state.reflected === true && !state.reflection_redone;
  return {
    state: {
      ...state,
      slots,
      out_of_catalog: undefined,
      ...(redo ? { reflected: false, reflection_redone: true } : {}),
    },
    message: redo
      ? "My read was off, then — tell me again what you're going for, in a line or two, and I'll take another swing."
      : 'No problem — want to aim at something I can build a full plan for? Anything from a 5K to a marathon, or just staying fit.',
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

/**
 * A confirmed in-catalog race supersedes the pocket, whatever its consent (the
 * stale accepted-pocket pivot, 2026-06-10 pressure-test): left in place, an
 * accepted pocket poisons the new race's `distance_mi` at commit, hijacks the
 * recap's goal line, and writes a stale North-star section — and reconcilePocket
 * can't help, since it only runs while consent is pending (and would wrongly
 * mark a pending pocket accepted when the new race's bucket equals the proxy).
 * The pocket's words demote to the intents, so the old goal rides as context
 * for the daily coach instead of vanishing. enforceGuardrails carries the
 * matching post-merge check for a typed pivot that skips the race lookup.
 */
export function supersedePocket(state: V3OnboardingState): V3OnboardingState {
  const pocket = state.out_of_catalog;
  if (!pocket) return state;
  return {
    ...state,
    out_of_catalog: undefined,
    intents: mergeIntents(state.intents, [pocket.words]),
  };
}

// ---------------------------------------------------------------------------
// Periodic volume goals (ULTRA_SUPPORT §6 — deferred feature, interim boundary)
// ---------------------------------------------------------------------------
// "100 miles a month" is a goal shape the catalog can't hold, and per David's
// 2026-06-10 decision the engine doesn't proxy it: it acknowledges the goal,
// states plainly that it can't coach toward it yet, and redirects to the two
// things it CAN do — general fitness, or training for a race. The number rides
// as an intent (context, not a commitment), so the recap and the preview still
// show it and the daily coach sees it in the profile.

/** Weeks per month, for normalizing a monthly target ("100 a month ≈ 23 a week"). */
const WEEKS_PER_MONTH = 4.345;

/** Redirect chips on the volume-boundary turn. Plain typed-text values the model
 *  interprets — these are NOT consent tokens, so no router fast path keys on them. */
export const VOLUME_REDIRECT_CHIPS: Chip[] = [
  { label: 'Keep me fit', value: 'just keep me generally fit, no race' },
  { label: 'Train for a race', value: 'I want to train for a race' },
];

/** The boundary + redirect body. Reads standalone AND after the composed
 *  "One thing to be straight about: " lead (first char gets lowercased there). */
export function volumeBoundaryBody(period: 'week' | 'month'): string {
  return `A ${period}ly mileage target isn't something I can coach you toward yet — I build training around runs per week, and races. What I can do: keep you generally fit with a rolling base, or train you for a race. Which sounds right?`;
}

export interface VolumeGoalResult {
  state: V3OnboardingState;
  /** True when this turn should be the boundary + redirect: the target is newly
   *  stated AND no race goal is in play. False = silent demote (the clause still
   *  rides as an intent — e.g. "60 miles a month" alongside a September race). */
  boundary: boolean;
  /** The normalized weekly read of the target (month ÷ 4.345, rounded). */
  miPerWeek: number;
}

/**
 * Fold a stated volume goal into state: the athlete-phrased clause joins the
 * intents (append-only, deduped — a restated target is not "new", so the
 * deterministic boundary fires at most once per distinct target; the model
 * holds the line conversationally after that). Race-in-play is read off the
 * POST-MERGE state (same-turn goal fills are already in the slots) plus the
 * turn's routing signals, so a volume target can never displace a race goal.
 */
export function applyVolumeGoal(
  state: V3OnboardingState,
  vg: { miles: number; period: 'week' | 'month' },
  output: ExtractAdvanceOutput,
): VolumeGoalResult {
  const miPerWeek = Math.round(vg.period === 'month' ? vg.miles / WEEKS_PER_MONTH : vg.miles);
  const clause = `${vg.miles} miles a ${vg.period}`;
  const added = !(state.intents ?? []).some((e) => e.toLowerCase() === clause.toLowerCase());
  const s = state.slots;
  const raceInPlay =
    output.race_lookup_query != null ||
    output.goal_distance_mi != null ||
    s.goal_type?.value === 'race' ||
    s.goal_race?.value != null ||
    (s.goal_distance?.value != null && s.goal_distance.value !== 'keep_fit');
  return {
    state: { ...state, intents: mergeIntents(state.intents, [clause]) },
    boundary: added && !raceInPlay,
    miPerWeek,
  };
}
