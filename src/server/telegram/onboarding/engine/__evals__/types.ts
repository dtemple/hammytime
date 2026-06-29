// V4-W6 onboarding eval harness — shared types.
//
// The harness drives the REAL onboarding engine (handleV3Message /
// handleV3Callback → the real callExtractAndAdvance against live Sonnet) with all
// I/O stubbed, and scores the resulting conversation against deterministic
// behavioral assertions. See `Specs/V4_W6_PROMPT.md` and `Specs/ONBOARDING_V4.md`
// §9 for the fixture/assertion catalogue this implements.

import type { StravaFitnessSnapshot } from '@/server/strava/activities';
import type { RaceLookupResult } from '@/server/agent/race-lookup';
import type { V3OnboardingState } from '../../slots/slot-state';

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

/** A forced move pins a specific turn to an exact athlete action, overriding the
 *  persona simulator. Used for token-exact cases (a named chip tap, e.g.
 *  `[Nothing right now]`), where letting the LLM improvise would desync the
 *  assertion. `turn` is 1-based
 *  and counts athlete turns (the opening message is turn 1). */
export interface ForcedMove {
  turn: number;
  move: { kind: 'text'; body: string } | { kind: 'chip'; label: string };
}

/** A frozen race-lookup table: maps a lowercased query substring to the result
 *  `lookupRace` would return. Removes both the DB dependency and a second
 *  nondeterministic Sonnet call — the race facts are the fixture's input, not the
 *  thing under test. A query with no entry falls back to `not_found`. */
export type FrozenRaceLookup = Record<string, RaceLookupResult>;

/** The declarative expectation set checked against the drive result. Every field
 *  is optional — a fixture asserts only what it cares about. Message-text checks
 *  that have no state field live in `customAssertions` instead. */
export interface FixtureExpect {
  /** The conversation must reach plan generation (generateAndPersistPlan called). */
  planGenerated?: boolean;
  /** The no-event off-ramp must fire (enterDormant called / phase 'off_ramp'). */
  offRamp?: boolean;
  /** A check-back interval was captured, or a clean stop taken (setCheckBack). */
  checkBackCaptured?: boolean;
  /** event_kind on the final state. */
  eventKind?: 'race' | 'adventure';
  /** The committed goal_distance bucket on the final state. */
  goalDistance?: string;
  /** goal_date must end with this suffix (e.g. '-15' for a mid-month resolution). */
  goalDateEndsWith?: string;
  /** event_distance_mi carried to commit. */
  eventDistanceMi?: number;
  /** Every substring here must appear in at least one captured intent. */
  intentsInclude?: string[];
  /** No goal_distance bucket may be written (the off-ramp / pre-bucket cases). */
  noBucketWritten?: boolean;
  /** lookupRace must NOT have been called (an athlete-stated adventure). */
  lookupNotCalled?: boolean;
  /** target_time must be unset/null (effort-led, no time-goal pace driver). */
  noTimeGoal?: boolean;
}

/** One eval fixture: a persona + ground-truth fact sheet for the simulator, an
 *  initial engine state, a frozen race table, optional forced moves, and the
 *  expectation set. `customAssertions` runs after the declarative checks for the
 *  rare message-text regex case. */
export interface OnboardingFixture {
  name: string;
  /** Free-text persona for the simulated athlete ("terse, real answers"). */
  persona: string;
  /** The ground-truth facts the simulator answers from — never invents beyond. */
  facts: Record<string, unknown>;
  /** The opening athlete message that kicks off the conversation. */
  opening: string;
  /** Seed for the in-memory state store (merged onto initialV3State). Carries the
   *  Strava snapshot so cold-start vs Strava-signal fixtures diverge. */
  initialState?: Partial<V3OnboardingState> & { strava_snapshot?: StravaFitnessSnapshot | null };
  /** Frozen race-lookup results keyed by lowercased query substring. */
  raceLookup?: FrozenRaceLookup;
  forcedMoves?: ForcedMove[];
  expect: FixtureExpect;
  /** Optional extra assertions (message-text regex etc.) given the drive result. */
  customAssertions?: (result: DriveResult) => void;
  /** Mark a fixture known-flaky against live Sonnet; surfaced in the scorecard,
   *  excluded from the hard gate. Document the reason. */
  knownFlaky?: string;
}

// ---------------------------------------------------------------------------
// Drive result
// ---------------------------------------------------------------------------

export type TurnDirection = 'athlete' | 'coach';

export interface TranscriptTurn {
  direction: TurnDirection;
  body: string;
  /** Chips offered with a coach message (label + callback_data). */
  chips?: Array<{ label: string; data: string }>;
}

/** One real engine turn's model output, captured by the wrapped callExtractAndAdvance. */
export interface ModelTurn {
  fills: Array<{ slot: string; value: unknown; provenance: string }>;
  next_action: string;
  message: string;
  chips: Array<{ label: string; value: string }>;
  /** A safety-relevant cross-slot conflict the model flagged this turn (null if none). */
  contradiction: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Recorded calls to the stubbed side-effect ports — the assertion surface. */
export interface RecordedPorts {
  commitSlots: number;
  generateAndPersistPlan: number;
  grantSignupCredit: number;
  enterDormant: Array<[string, string | null]>;
  setCheckBack: Array<[string, string | null]>;
  exitDormant: number;
  sendDavidAlert: number;
  lookupRace: string[];
}

export type DriveOutcome = 'completed' | 'offramped' | 'did_not_converge';

export interface DriveResult {
  fixture: OnboardingFixture;
  outcome: DriveOutcome;
  transcript: TranscriptTurn[];
  finalState: V3OnboardingState;
  ports: RecordedPorts;
  modelTurns: ModelTurn[];
  /** Total Sonnet spend across engine + simulator calls, USD. */
  costUsd: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  uncachedInputTokens: number;
  /** Per-fixture assertion failures (empty = pass). */
  failures: string[];
  /** Optional Opus voice score (Part 5), 1-5, and its one-line justification. */
  voice?: { score: number; note: string };
}

/** The injected side-effect surface the drive loop reads. Owned by the eval entry
 *  (where the vi.mock hoisting lives), passed into driveFixture so the loop stays
 *  pure orchestration. */
export interface HarnessPorts {
  /** Captured outbound coach messages: [chatId, text, opts]. */
  sentMessages: Array<[number | string, string, unknown]>;
  recorded: RecordedPorts;
  modelTurns: ModelTurn[];
  /** The running conversation, in the engine's HistoryTurn shape, so the mocked
   *  loadRecentHistory can feed the real model prior turns (without it the model
   *  loses context every turn). 'in' = athlete, 'out' = coach. */
  history: Array<{ direction: 'in' | 'out'; body: string }>;
  /** Reset between fixtures. */
  reset: () => void;
  /** The in-memory state store, keyed by athleteId. */
  stateStore: Map<string, V3OnboardingState>;
}
