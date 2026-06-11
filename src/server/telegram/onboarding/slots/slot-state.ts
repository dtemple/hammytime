// Onboarding v3 (V3-W1): the persisted slot state + load/persist helpers.
//
// v3 stores a NEW TOP-LEVEL shape directly as athletes.onboarding_state (decided
// 2026-06-04) — NOT nested under v2's { step, question, partial }. The whole
// onboarding_state column is therefore either a v2 object (no `flow` key) or a v3
// object (`flow: 'v3'`). The `flow` discriminator is how the loader and the
// dispatcher switch (W2) tell them apart.
//
// Storage reuses the existing set_onboarding_state RPC, which writes the JSONB
// column wholesale, so no migration is needed. The dispatcher routing switch, the
// ONBOARDING_V3 env-flag read, and the bot.ts gate edit that calls
// isV3OnboardingComplete are W2.

import { supabaseAdmin } from '@/lib/db';
import type { KnownGapKey } from '@/lib/known-gaps';
import type { StravaFitnessSnapshot } from '@/server/strava/activities';
import { isFilled, slotValue } from './provenance';
import {
  requiredCoreSlots,
  type ExperienceTierValue,
  type GoalDistanceValue,
  type GoalTypeValue,
  type SlotKey,
  type SlotState,
} from './schema';

/** Bump when the persisted shape changes incompatibly. loadV3State resets a
 *  mid-flight state on mismatch rather than crash a resuming athlete (the JSONB
 *  outlives a multi-day flow, and W2/W3 will reshape it during dev).
 *  v2 (V3-W8): added the `out_of_catalog` pocket field. */
export const V3_SCHEMA_VERSION = 2;

/** Pinned at 8 for headroom (ONBOARDING_V3 decision #4). */
export const DEFAULT_OPTIONAL_BUDGET = 8;

export type OnboardingPhase = 'orientation' | 'intake' | 'recap' | 'complete';

/**
 * The /edit_profile re-entry marker (W3). Onboarding ends at phase 'complete';
 * `edit_mode` is how a completed athlete re-enters the engine to walk their open
 * known-gaps ("Finish my profile"). "Update something" needs no marker — a
 * completed athlete's free text already routes to the coach, so it just sends a
 * prompt. The gap queue is captured once when the walk starts (`remaining`) so
 * each gap is asked exactly once and the walk terminates.
 */
export interface EditMode {
  kind: 'finish_gaps';
  /** The gap we just asked — the slot the next inbound answer fills. */
  current_gap: KnownGapKey;
  /** Gaps still to ask after current_gap, in order. */
  remaining: KnownGapKey[];
}

/**
 * A guardrail-issued confirm that is still outstanding (the generate-gate override
 * echoing an inferred safety/plan-driving slot for a yes/no). Set by the engine
 * when the confirm goes out; a `yes` chip tap resolves it in code with no model
 * call (router fast path). `attempts` is the per-slot+value confirm counter — the
 * same confirm is never sent a third time; the would-be third turn becomes a
 * direct plain-words ask instead, so the athlete's restatement lands as a `stated`
 * fill. (V3 engine hardening — the 2026-06-05 confirm-loop fix.)
 */
export interface PendingConfirm {
  slot: SlotKey;
  /** The value being confirmed (used to detect a same-slot+value re-issue). */
  value: unknown;
  /** How many times this slot+value confirm has gone out (starts at 1). */
  attempts: number;
}

/**
 * A goal the current catalog can't structure — an oversize race distance, a
 * non-race objective with no in-catalog distance (V3-W8, ONBOARDING_V3 §5.2).
 * Detected in CODE (a confirmed race's distance_mi out of the bucket bands, or a
 * stated distance the model surfaced as `goal_distance_mi`), never a model guess.
 * The engine acknowledges it plainly, offers the nearest in-catalog structure
 * (`proxy`) with consent, and — on accept — stores `words` for the daily coach.
 */
export interface OutOfCatalogGoal {
  /** The athlete's own description of the goal (race name, or their message). */
  words: string;
  /** The real distance when known (miles); null for a shapeless objective. */
  distance_mi: number | null;
  /** The nearest in-catalog structure offered — `marathon` above the catalog,
   *  `5k` below the floor (R1 fix 1). */
  proxy: GoalDistanceValue;
  /** pending = consent turn is out; accepted = proxy taken; declined is handled
   *  by clearing the pocket (re-offer), so it's not persisted. */
  consent: 'pending' | 'accepted' | 'declined';
}

export interface V3OnboardingState {
  flow: 'v3';
  schema_version: number;
  phase: OnboardingPhase;
  slots: SlotState;
  /** Set only while a post-completion /edit_profile "Finish my profile" walk is
   *  active; absent otherwise. Routes the next inbound back to the engine. */
  edit_mode?: EditMode;
  /** Hard counter the engine decrements per optional question (§5.4); not a
   *  number the model is trusted to respect. */
  optional_budget_remaining: number;
  /** Slots the bot has already asked — backs re-ask avoidance and the
   *  "injury beat is always asked" invariant. */
  asked: SlotKey[];
  /** The Strava fitness snapshot, fetched once and cached. v2 re-fetched it per
   *  step because partial was wiped between steps; v3's single continuous state
   *  reuses it across openers, saving a round-trip on the inline webhook path. */
  strava_snapshot?: StravaFitnessSnapshot | null;
  /** Dedup key of the last inbound processed by the engine (`m:<message_id>` or
   *  `c:<callback_id>`) — drops a retried webhook (Telegram re-delivers slow
   *  turns) so it can't double-run the Sonnet call. */
  last_processed_key?: string;
  /** Set once the slots have been written to the DB, so a generate retry (e.g.
   *  plan-gen failed after commit) doesn't duplicate the race/injury rows. */
  committed?: boolean;
  /** A guardrail-issued confirm awaiting an answer. Absent = nothing pending. The
   *  engine owns this field end to end: set when a generate-gate confirm goes out,
   *  cleared on any other resolution. */
  pending_confirm?: PendingConfirm;
  /** An uncatalogued goal awaiting (or holding) the athlete's consent to the
   *  marathon-proxy (V3-W8). Absent until a goal lands outside the catalog. */
  out_of_catalog?: OutOfCatalogGoal;
  /** The slot/value pairs the last outbound recap displayed (R1 fix 2). Set on
   *  every recap resolution, cleared on any other, so it always means "the last
   *  message was a recap". An affirmation — the recap chip, or a typed reply the
   *  model resolves to generate — bulk-confirms every pair whose value is
   *  unchanged, in code; an affirmed recap must never be followed by per-slot
   *  "Quick check" turns for values it already displayed (the Nathan transcript). */
  recap_shown?: Array<{ slot: SlotKey; value: unknown }>;
}

/** The starting v3 state, post-Strava. The fitness snapshot is cached here; the
 *  Strava-inferred slots (experience_tier, days/week, long-run day) are seeded
 *  and stated back by the engine/openers (W2/W3), not here. */
export function initialV3State(snapshot?: StravaFitnessSnapshot | null): V3OnboardingState {
  return {
    flow: 'v3',
    schema_version: V3_SCHEMA_VERSION,
    phase: 'orientation',
    slots: {},
    optional_budget_remaining: DEFAULT_OPTIONAL_BUDGET,
    asked: [],
    strava_snapshot: snapshot ?? null,
  };
}

/**
 * A conservative experience-tier read from the Strava snapshot — extremes only.
 *
 * v2's training-shape step deliberately asked experience as a plain choice
 * because "Strava volume is a poor proxy for how someone describes their own
 * training level" (steps/02-training-shape.ts). v3 keeps that caution: this only
 * commits a guess at the confident ends (clearly a beginner / clearly
 * experienced) and returns null through the ambiguous middle, where `for_fun`
 * vs. `some_training` is intent — not volume — and the model asks cold. Whatever
 * it returns is seeded `inferred`/unconfirmed, so Opener 2 states it back for a
 * one-tap correction; a wrong guess costs the athlete nothing.
 */
export function inferExperienceTier(snapshot: StravaFitnessSnapshot): ExperienceTierValue | null {
  if (snapshot.run_count < 4 || snapshot.weeks_observed < 2) return null; // too thin to read
  const { recent_weekly_mileage_mi: miles, longest_run_mi: longest } = snapshot;
  if (miles >= 30 && longest >= 13) return 'experienced';
  if (miles <= 8 && longest <= 4) return 'beginner';
  return null; // the for_fun / some_training middle — ask, don't guess
}

/**
 * Seed the three Strava-inferable training-shape slots as `inferred`/unconfirmed
 * (W3). The `firstUnconfirmedInferred` guardrail then forces a stated-back
 * confirm (Opener 2) before plan-gen, deterministically — rather than trusting
 * the model to remember to infer them from the snapshot text each run. Returns a
 * new slot map; only slots with a usable signal are added.
 *
 * No running signal (run_count 0) → nothing is seeded and the engine asks cold,
 * matching the snapshot summary the model already sees.
 */
export function seedStravaInferences(
  slots: SlotState,
  snapshot: StravaFitnessSnapshot | null | undefined,
): SlotState {
  if (!snapshot || snapshot.run_count === 0) return slots;
  const next: SlotState = { ...slots };

  next.days_per_week = slotValue(snapshot.suggested_days_per_week, 'inferred', false);

  if (snapshot.dominant_long_run_weekday != null) {
    next.long_run_day = slotValue(snapshot.dominant_long_run_weekday, 'inferred', false);
  }

  const tier = inferExperienceTier(snapshot);
  if (tier) next.experience_tier = slotValue(tier, 'inferred', false);

  return next;
}

function isV3Shape(raw: unknown): raw is V3OnboardingState {
  return !!raw && typeof raw === 'object' && (raw as { flow?: unknown }).flow === 'v3';
}

/**
 * Load the v3 onboarding state for an athlete.
 *
 * Returns null when onboarding_state is empty or a v2-shaped object (no `flow`),
 * so the caller can fall back to the v2 dispatcher. On a schema_version mismatch
 * the state is reset to a fresh v3 state, preserving the cached Strava snapshot
 * so the reset doesn't trigger a re-fetch.
 */
export async function loadV3State(athleteId: string): Promise<V3OnboardingState | null> {
  const { data, error } = await supabaseAdmin()
    .from('athletes')
    .select('onboarding_state')
    .eq('id', athleteId)
    .single();

  if (error || !data) return null;

  const raw = data.onboarding_state as unknown;
  if (!isV3Shape(raw)) return null;

  if (raw.schema_version !== V3_SCHEMA_VERSION) {
    return initialV3State(raw.strava_snapshot ?? null);
  }
  return raw;
}

/** Persist the v3 state as the entire onboarding_state column. */
export async function saveV3State(athleteId: string, state: V3OnboardingState): Promise<void> {
  const { error } = await supabaseAdmin().rpc('set_onboarding_state', {
    p_athlete_id: athleteId,
    p_new_state: state,
  });
  if (error) throw new Error(`saveV3State failed: ${error.message}`);
}

/**
 * Atomically replace a v2 `awaiting_strava` state with the seeded v3 state, only
 * if the athlete is still awaiting Strava — the same idempotency gate the v2
 * resume uses, so a duplicate Strava callback can't double-seed. Returns whether
 * it wrote.
 */
export async function seedV3IfAwaitingStrava(
  athleteId: string,
  state: V3OnboardingState,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('set_onboarding_state_if_substep', {
    p_athlete_id: athleteId,
    p_new_state: state,
    p_expected_substep: 'awaiting_strava',
  });
  if (error) throw new Error(`seedV3IfAwaitingStrava failed: ${error.message}`);
  return data === true;
}

/** Whether onboarding v3 is the active flow for new athletes. v3 is the default
 *  (it shipped 2026-06-05) — ON unless `ONBOARDING_V3` is explicitly set to a
 *  disable value (`false`/`0`/`off`). The env var is now a kill-switch back to v2,
 *  not an enable-switch, completing the v0.7.20 decision #3 (the flag was always a
 *  temporary fallback, never a long-lived A/B). An athlete already mid-v3
 *  (state.flow === 'v3') keeps using v3 regardless. */
export function isV3Enabled(): boolean {
  const v = process.env.ONBOARDING_V3?.toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off';
}

/**
 * Whether onboarding can hand off to plan generation: every required-core slot
 * (goal-type-aware — a keep_fit athlete needs no race) is filled, and the injury
 * beat has been answered.
 *
 * The injury beat is a SOFT gate (decision #6): a `[Skip]` writes injury_status
 * with the value `unknown` — a non-null, answered value — which satisfies the
 * gate and generates a conservative plan. Only a never-asked injury (the slot
 * absent entirely) leaves the beat open.
 */
export function isV3OnboardingComplete(state: V3OnboardingState): boolean {
  const goalType = (state.slots.goal_type?.value as GoalTypeValue | null) ?? null;
  const coreFilled = requiredCoreSlots(goalType).every((k) => isFilled(state.slots[k]));
  const injuryAnswered = state.slots.injury_status?.value != null;
  return coreFilled && injuryAnswered;
}
