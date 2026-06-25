// Plan template library — type layer (onboarding v2, W3).
//
// Design in one paragraph: a template is NOT a baked plan. It's a parametric
// structural skeleton + a coaching-content library. The single *library axis*
// is race distance (you can't scale a 5k into a marathon). Experience tier
// selects a *band* and feeds volume numbers; timeline, days/week, long-run day,
// current volume, trail-vs-road, and time-goal are render-time parameters and
// overlays — not separate templates. A deterministic renderer expands a
// (template + params) into a schema-valid `Plan` (see ./renderer). The worker
// coach agent customizes on top of that Plan later (the [Adjust it] path).
//
// Six templates: marathon-finish, marathon-performance, half-foundation,
// half-development, short-race (5k+10k), base-maintenance. See ./selector for
// the (distance × tier) → template mapping.

import type { DayType, PhaseName, Plan } from '@/lib/plan-schema';
import type { KnownGapKey, StrengthEquipment } from '@/lib/known-gaps';

// ---------------------------------------------------------------------------
// Profile enums — mirror athlete_training_profile (keep in sync with the
// migration 20260601000000_athlete_training_profile.sql).
// ---------------------------------------------------------------------------

export type ExperienceTier = 'beginner' | 'for_fun' | 'some_training' | 'experienced';
export type GoalDistance = '5k' | '10k' | 'half' | 'marathon' | '50k' | 'keep_fit';
export type Terrain = 'road' | 'trail' | 'mixed';
export type TargetType = 'finish' | 'time';

export type TemplateId =
  | 'marathon-finish'
  | 'marathon-performance'
  | 'half-foundation'
  | 'half-development'
  | 'short-race'
  | 'base-maintenance'
  | 'ultra-50k';

/** The structural band a template embodies. Tier maps onto a band; the band
 *  fixes the structure (quality-day count, intensity menu, long-run ceiling),
 *  while tier + Strava feed the numbers. */
export type Band = 'foundation' | 'development' | 'performance' | 'maintenance';

export type OverlayKind = 'trail' | 'time_goal' | 'injury' | 'open_ended';

// ---------------------------------------------------------------------------
// Phase plan — the structural skeleton.
// ---------------------------------------------------------------------------

/** A phase's share of the build. The renderer allocates `total_weeks` across
 *  phases by `weight`, honoring min/max, then relabels cutback weeks via
 *  `CutbackRule` (cutback is NOT listed here — it's overlaid). In open-ended
 *  mode (no race date) only phases with `openEndedKeep` are emitted. */
export interface PhaseTemplate {
  name: Exclude<PhaseName, 'cutback'>; // base | build | peak | taper | race
  weight: number; // relative share of the distributable weeks; need not sum to 1
  minWeeks: number;
  maxWeeks?: number;
  openEndedKeep: boolean; // kept when no date is bound (base/build true; peak/taper/race false)
  description: string;
}

export interface CutbackRule {
  everyNWeeks: number; // e.g. 4 — every 4th week becomes a down week
  volumePct: number; // e.g. 0.8 — cut to 80% of the ramping volume
}

// ---------------------------------------------------------------------------
// Volume model — how the Strava snapshot becomes weekly volume + long-run
// progression. Numeric values are band/distance bands; all hard limits also
// pass through SafetyCaps at validation time.
// ---------------------------------------------------------------------------

export interface LongRunModel {
  startAnchor: 'strava_longest' | 'fraction_of_start';
  startFraction?: number; // used when startAnchor === 'fraction_of_start'
  capMi: number; // band/distance long-run ceiling (e.g. 20 finish, 22 performance)
  weeklyStepMi: number; // max weekly increase (<= caps.maxLongRunStepMi)
  postCutbackStepMi: number; // allowed bump the week after a cutback
  shareOfWeeklyMax: number; // long run <= this fraction of the week (e.g. 0.35)
}

export interface VolumeModel {
  startVolumeFloorMi: number; // never start below this even if Strava is lower
  peakVolumeCapMi: number; // band/distance weekly ceiling
  peakMultiplierMax: number; // peak <= startVolume * this (e.g. 1.8)
  longRun: LongRunModel;
}

// ---------------------------------------------------------------------------
// Microcycle — week shape per run-day count, before dates/mileage are filled.
// ---------------------------------------------------------------------------

/** Role a run-day plays in the week. `quality` resolves to a phase-appropriate
 *  workout from `workoutMenu` at render time. Strength is layered separately and
 *  does NOT appear here — it never consumes a run day. */
export type RunRole = 'long_run' | 'easy' | 'easy_with_strides' | 'quality';

/** Ordered run-day roles for one week. The renderer rotates this so the long run
 *  lands on the athlete's long_run_day and enforces hard-day spacing
 *  (caps.minEasyDaysBetweenHard). */
export type MicrocyclePattern = RunRole[];

/** Keyed by runs_per_week. A template need not support every count; the selector
 *  clamps the athlete's choice into the supported range. */
export type MicrocycleLibrary = Partial<Record<number, MicrocyclePattern>>;

// ---------------------------------------------------------------------------
// Workout menu — the coaching content the renderer drops onto `quality` slots.
// Fields mirror DaySchema; the renderer copies them through and fills in
// per-week distance/pace. A `[start, end]` progression is resolved to a single
// value per week by the renderer.
// ---------------------------------------------------------------------------

export interface WorkoutSpec {
  id: string;
  dayType: Extract<
    DayType,
    'hill_repeats' | 'tempo' | 'trail_tempo' | 'intervals' | 'easy_with_strides'
  >;
  phases: PhaseName[]; // phases this workout is eligible for
  // Structure — subset used per dayType; all optional, all mirror DaySchema:
  warmupMin?: number;
  cooldownMin?: number;
  repeats?: [number, number]; // progression across the phase → single int per week
  repeatDurationSec?: number;
  repeatDistanceM?: number;
  recovery?: string;
  tempoBlockMin?: [number, number]; // progression
  strides?: { count: [number, number]; durationSec: number; recovery: string };
  description: string; // human label; renderer may append concrete numbers
}

// ---------------------------------------------------------------------------
// Pace model — how pace_zones are produced.
// ---------------------------------------------------------------------------

export interface PaceModel {
  /** effort = HR/RPE-led (trail, finish); pace = pace-led (road time goal). */
  primary: 'effort' | 'pace';
  /** Derive concrete pace_sec_per_mile from RenderParams.target_time_sec. */
  deriveFromTarget: boolean;
  /** v1: 'riegel'-style equivalent paces, or 'none' (effort-only). */
  derivation: 'riegel' | 'none';
}

// ---------------------------------------------------------------------------
// Strength — layered on top of the run plan, never consuming a run day.
// ---------------------------------------------------------------------------

// The schema's strength session shape carries a bound `day`; a template library
// holds the session WITHOUT a day (the renderer assigns placement). Derive the
// type from Plan so it stays in lockstep with plan-schema.ts.
type SchemaStrengthSession = NonNullable<NonNullable<Plan['strength_workouts']>['upper_body']>;
export type StrengthSessionTemplate = Omit<SchemaStrengthSession, 'day'>;

export interface StrengthModel {
  /** Default session count by tier (the athlete can opt out in the B1 preview /
   *  chat — applied upstream of the renderer). Counts are ADDITIONAL sessions,
   *  not run days: runs_per_week stays the athlete's stated number. */
  defaultSessionsByTier: Record<ExperienceTier, 0 | 1 | 2>;
  placement: 'combine_with_easy_day' | 'standalone_day';
  /** Equipment assumed until the `strength_equipment` known gap is filled.
   *  Always 'bodyweight_only' at launch — bodyweight works for everyone. */
  defaultEquipment: StrengthEquipment;
  /** Shared session library (bodyweight-first). Maps to Plan['strength_workouts']
   *  once the renderer binds a day to each. */
  sessions: {
    upper_body?: StrengthSessionTemplate;
    lower_body?: StrengthSessionTemplate;
  };
}

// ---------------------------------------------------------------------------
// PlanTemplate — the whole declarative spec.
// ---------------------------------------------------------------------------

export interface PlanTemplate {
  id: TemplateId;
  label: string;
  distances: GoalDistance[]; // which goal_distance values this template serves
  band: Band;
  appliesToTiers: ExperienceTier[];

  phases: PhaseTemplate[];
  cutback: CutbackRule;
  volume: VolumeModel;
  microcycles: MicrocycleLibrary;
  workoutMenu: WorkoutSpec[];
  paceModel: PaceModel;
  strength: StrengthModel;

  /** agent_guidance base for this template (pace zones, compliance rules,
   *  modification triggers). The renderer merges overlay deltas + the shared
   *  compliance base and fills athlete-specific values (race, derived paces). */
  guidanceBase: NonNullable<Plan['agent_guidance']>;

  supportsOverlays: OverlayKind[];
}

// ---------------------------------------------------------------------------
// Safety caps — the load-bearing content-safety limits. They are BOTH the
// ceiling the renderer ramps toward AND the validator the output must pass.
//
// ⚠ NUMBERS ARE NOT DEFINED HERE. The concrete values are the still-open
// "schema-validator safety caps" decision (SPEC §7 / claude-status deferred).
// This is the shape; the values land with that decision.
// ---------------------------------------------------------------------------

export interface SafetyCaps {
  maxWeeklyRampPct: number; // week-over-week volume increase % (governs at higher volume)
  minWeeklyRampMi: number; // absolute floor: a week may grow by the GREATER of pct or this
  maxLongRunStepMi: number; // e.g. 2 — long-run increase ceiling
  postCutbackLongRunStepMi: number; // e.g. 3 — allowed bump after a cutback
  maxLongRunShareOfWeekly: number; // e.g. 0.35 — long run as a fraction of the week
  minEasyDaysBetweenHard: number; // e.g. 1 — easy/rest days between quality sessions
  maxLongRunMiByDistance: Record<GoalDistance, number>; // per-distance LR ceiling
}

// ---------------------------------------------------------------------------
// RenderParams — everything the renderer needs that isn't in the template.
// Produced by the selector from athlete_training_profile + the Strava snapshot.
// ---------------------------------------------------------------------------

export interface RenderRace {
  name: string;
  date: string; // ISO yyyy-mm-dd
  distanceMiles: number;
  elevationGainFt?: number;
  type: Terrain;
  targetType: TargetType;
  targetTimeSec?: number;
}

export interface InjuryAccommodation {
  bodyPart: string;
  reduceVolumePct?: number; // light, render-time accommodation
  avoidDayTypes?: DayType[]; // e.g. avoid hill_repeats for an achilles flag
}

export interface RenderParams {
  templateId: TemplateId;
  tier: ExperienceTier;
  distance: GoalDistance;
  terrain: Terrain;

  // Calendar
  startDate: string; // ISO; athlete-local "today"
  totalWeeks: number | null; // null => open-ended (A4b "no date yet")
  race: RenderRace | null; // present when goal_state = 'committed'
  /** Week-1 ease-in opt-out. Default (absent/true): when startDate falls inside
   *  week 1, that week is a partial ease-in (mid-week onboarding). A plan
   *  continuation rendered ahead of time (GF-W1) starts on a future Monday —
   *  startDate equals the week-1 Monday, which WOULD match the ease-in
   *  condition — so it passes false to get a normal full week 1. */
  easeIn?: boolean;

  // Volume — computed from the Strava snapshot, clamped to template + caps
  startVolumeMi: number;
  peakVolumeMi: number;
  startLongRunMi: number;
  longRunCapMi: number;

  // Week shape
  runsPerWeek: number; // = athlete days_per_week (RUN days)
  strengthSessionsPerWeek: 0 | 1 | 2; // ADDITIONAL sessions, not run days
  longRunDay: number; // 0=Sun..6=Sat

  // Goal
  targetType: TargetType;
  targetTimeSec: number | null;
  /** time_goal is permitted but the flow should steer the athlete away from it
   *  (a some_training runner's first marathon). W4's preview surfaces the nudge;
   *  `time_goal` is still in `overlays` unless the athlete declines. */
  timeGoalDiscouraged: boolean;

  // Modifiers
  overlays: OverlayKind[];
  injuryAccommodations: InjuryAccommodation[];

  // Bookkeeping
  caps: SafetyCaps;
  strengthEquipment: StrengthEquipment; // 'unknown' => bodyweight prescription
  openKnownGaps: KnownGapKey[]; // gaps still unfilled at gen time
}
