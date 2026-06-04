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
import type { StravaFitnessSnapshot } from '@/server/strava/activities';
import { isFilled } from './provenance';
import { requiredCoreSlots, type GoalTypeValue, type SlotKey, type SlotState } from './schema';

/** Bump when the persisted shape changes incompatibly. loadV3State resets a
 *  mid-flight state on mismatch rather than crash a resuming athlete (the JSONB
 *  outlives a multi-day flow, and W2/W3 will reshape it during dev). */
export const V3_SCHEMA_VERSION = 1;

/** Pinned at 8 for headroom (ONBOARDING_V3 decision #4). */
export const DEFAULT_OPTIONAL_BUDGET = 8;

export type OnboardingPhase = 'orientation' | 'intake' | 'recap' | 'complete';

export interface V3OnboardingState {
  flow: 'v3';
  schema_version: number;
  phase: OnboardingPhase;
  slots: SlotState;
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

/** Whether onboarding v3 is the active flow for new athletes (global env flag).
 *  An athlete already mid-v3 (state.flow === 'v3') keeps using v3 regardless. */
export function isV3Enabled(): boolean {
  const v = process.env.ONBOARDING_V3;
  return v === 'true' || v === '1';
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
