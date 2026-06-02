// Template selector (onboarding v2, W3).
//
// Two jobs: (1) pick the template from (distance × tier) — pure, implemented
// below; (2) compute the RenderParams from the training profile + Strava
// snapshot — signature + algorithm documented here, body lands with the W3
// build (it depends on the safety-cap numbers, still open).

import type {
  ExperienceTier,
  GoalDistance,
  RenderParams,
  SafetyCaps,
  TargetType,
  TemplateId,
  Terrain,
} from './types';

// ---------------------------------------------------------------------------
// (distance × tier) → template. The structural axis is distance; tier mostly
// selects the band + feeds volume params.
//
// Edge rules baked into the table:
//   • marathon + some_training → finish (a first marathon stays conservative).
//   • marathon-performance is gated on `experienced` only.
//   • 5k and 10k share `short-race`; tier spans run/walk-beginner →
//     intervals-experienced via params, not separate templates.
// ---------------------------------------------------------------------------

export const SELECTION_TABLE: Record<GoalDistance, Record<ExperienceTier, TemplateId>> = {
  '5k': {
    beginner: 'short-race',
    for_fun: 'short-race',
    some_training: 'short-race',
    experienced: 'short-race',
  },
  '10k': {
    beginner: 'short-race',
    for_fun: 'short-race',
    some_training: 'short-race',
    experienced: 'short-race',
  },
  half: {
    beginner: 'half-foundation',
    for_fun: 'half-foundation',
    some_training: 'half-development',
    experienced: 'half-development',
  },
  marathon: {
    beginner: 'marathon-finish',
    for_fun: 'marathon-finish',
    some_training: 'marathon-finish',
    experienced: 'marathon-performance',
  },
  keep_fit: {
    beginner: 'base-maintenance',
    for_fun: 'base-maintenance',
    some_training: 'base-maintenance',
    experienced: 'base-maintenance',
  },
};

export function selectTemplateId(distance: GoalDistance, tier: ExperienceTier): TemplateId {
  return SELECTION_TABLE[distance][tier];
}

// ---------------------------------------------------------------------------
// time_goal eligibility — gated harder than the other overlays.
//
// A stated finish time is the riskiest input to let drive paces, so we don't
// build pace work off a number a first-timer invented. trail/injury/open_ended
// are data-driven and need no policy; time_goal is tier-gated per template:
//   • performance / development     → open (any tier with a time goal).
//   • short-race                    → open (short races are pace-driven; even
//                                     beginners benefit from a goal pace).
//   • marathon-finish + some_training → permitted but DISCOURAGED (the flow
//                                     steers them away; they can opt in).
//   • marathon-finish (beginner/for_fun), half-foundation, base-maintenance
//                                   → suppressed.
// ---------------------------------------------------------------------------

export interface TimeGoalEligibility {
  eligible: boolean;
  discouraged: boolean;
}

export function timeGoalEligibility(
  templateId: TemplateId,
  tier: ExperienceTier,
): TimeGoalEligibility {
  switch (templateId) {
    case 'marathon-performance':
    case 'half-development':
    case 'short-race':
      return { eligible: true, discouraged: false };
    case 'marathon-finish':
      return tier === 'some_training'
        ? { eligible: true, discouraged: true }
        : { eligible: false, discouraged: false };
    case 'half-foundation':
    case 'base-maintenance':
    default:
      return { eligible: false, discouraged: false };
  }
}

// ---------------------------------------------------------------------------
// Selector inputs.
// ---------------------------------------------------------------------------

/** The fields the selector reads from athlete_training_profile + the committed
 *  race (if any). */
export interface SelectorProfile {
  experienceTier: ExperienceTier;
  goalDistance: GoalDistance;
  daysPerWeek: number; // RUN days (the A5 tap)
  longRunDay: number; // 0=Sun..6=Sat
  goalState: 'committed' | 'intended' | 'day_to_day';
  targetDate: string | null; // ISO; placeholder for intended, race date for committed
  targetType: TargetType;
  targetTimeSec: number | null;
  race: {
    name: string;
    date: string;
    distanceMiles: number;
    elevationGainFt?: number;
    type: Terrain;
  } | null;
  injuries: { bodyPart: string }[];
  today: string; // athlete-local ISO date
}

/** The subset of getFitnessSnapshot (src/server/strava/activities.ts) the
 *  selector reads. Declared structurally so lib/ doesn't depend on server/;
 *  keep in sync with StravaFitnessSnapshot. */
export interface FitnessSnapshotInput {
  recentWeeklyMileageMi: number;
  avgWeeklyMileageMi: number;
  longestRunMi: number;
  runsPerWeek: number;
  suggestedDaysPerWeek: number;
  dominantLongRunWeekday: number | null;
  roadTrailMix: { road: number; trail: number };
}

// ---------------------------------------------------------------------------
// computeRenderParams — profile + snapshot → RenderParams.
// ---------------------------------------------------------------------------

/**
 * Produce the full RenderParams for the renderer.
 *
 * Algorithm (implement in the W3 build — body deferred until the safety-cap
 * numbers are pinned):
 *
 *  1. templateId = selectTemplateId(distance, tier); load that template.
 *  2. totalWeeks:
 *       committed / intended-with-date → whole weeks between today and
 *         targetDate; intended-no-date / keep_fit → null (open-ended).
 *  3. startVolumeMi = max(snapshot.recentWeeklyMileageMi,
 *       template.volume.startVolumeFloorMi).
 *  4. peakVolumeMi = min(template.volume.peakVolumeCapMi,
 *       startVolumeMi * template.volume.peakMultiplierMax), additionally clamped
 *       so it's reachable within totalWeeks at <= caps.maxWeeklyRampPct. If it
 *       isn't reachable, clamp and flag (caller surfaces an honest "aggressive
 *       for your base" note).
 *  5. startLongRunMi from template.volume.longRun.startAnchor (Strava longest, or
 *       a fraction of start); longRunCapMi = min(template cap,
 *       caps.maxLongRunMiByDistance[distance]).
 *  6. runsPerWeek = clamp(daysPerWeek, supported microcycle range).
 *  7. strengthSessionsPerWeek = template.strength.defaultSessionsByTier[tier],
 *       unless the athlete opted out (→ 0).
 *  8. overlays: 'trail' when race.type is trail / snapshot.roadTrailMix leans
 *       trail; 'time_goal' when targetType === 'time' AND
 *       timeGoalEligibility(templateId, tier).eligible (set timeGoalDiscouraged
 *       from .discouraged); 'injury' when injuries present; 'open_ended' when
 *       totalWeeks === null.
 *  9. strengthEquipment from the athlete's known-gap state (unknown until the
 *       gap is filled → bodyweight); openKnownGaps = still-unfilled gap keys.
 */
export function computeRenderParams(
  profile: SelectorProfile,
  snapshot: FitnessSnapshotInput | null,
  caps: SafetyCaps,
): RenderParams {
  void profile;
  void snapshot;
  void caps;
  throw new Error('computeRenderParams: not implemented (W3 build — pending safety-cap numbers)');
}
