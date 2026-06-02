// Template selector (onboarding v2, W3).
//
// Two jobs: (1) pick the template from (distance × tier) — pure, implemented
// below; (2) compute the RenderParams from the training profile + Strava
// snapshot — signature + algorithm documented here, body lands with the W3
// build (it depends on the safety-cap numbers, still open).

import type {
  ExperienceTier,
  GoalDistance,
  InjuryAccommodation,
  OverlayKind,
  PlanTemplate,
  RenderParams,
  RenderRace,
  SafetyCaps,
  TargetType,
  TemplateId,
  Terrain,
} from './types';
import type { DayType } from '@/lib/plan-schema';
import type { KnownGapKey, StrengthEquipment } from '@/lib/known-gaps';

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

// Nominal race miles per goal distance — used for the placeholder race that
// no-race plans still need (PlanSchema requires metadata.race) and for the
// terrain default. keep_fit uses a non-standard value so the distance bucket
// resolves back to keep_fit, not 10k.
const DISTANCE_MILES: Record<GoalDistance, number> = {
  '5k': 3.1,
  '10k': 6.2,
  half: 13.1,
  marathon: 26.2,
  keep_fit: 5,
};

// Plan-length guard rails. A race in the past/today floors at 1 week (allocate
// will compress); a race years out caps at 30 (the daily coach extends later).
const MIN_PLAN_WEEKS = 1;
const MAX_PLAN_WEEKS = 30;

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function whole_weeks_between(fromISO: string, toISO: string): number {
  const ms = Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`);
  return Math.floor(ms / (7 * 24 * 3600 * 1000));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Map a free-text injury body part to a light render-time accommodation. The
 *  daily coach refines this later; here it just keeps obviously-risky day types
 *  off a flagged body part and shaves a little volume. */
function toInjuryAccommodation(bodyPart: string): InjuryAccommodation {
  const p = bodyPart.toLowerCase();
  const avoid: DayType[] = [];
  let reduce: number | undefined;
  if (/(achilles|calf|ankle|foot|plantar)/.test(p)) {
    avoid.push('hill_repeats');
    reduce = 0.1;
  } else if (/(knee|itb|it band|patell)/.test(p)) {
    avoid.push('hill_repeats');
    reduce = 0.1;
  } else if (/(hamstring|glute|hip)/.test(p)) {
    avoid.push('intervals');
    reduce = 0.1;
  } else if (/(shin|tibia)/.test(p)) {
    reduce = 0.15;
  }
  return {
    bodyPart,
    ...(avoid.length ? { avoidDayTypes: avoid } : {}),
    ...(reduce ? { reduceVolumePct: reduce } : {}),
  };
}

function deriveTerrain(profile: SelectorProfile, snapshot: FitnessSnapshotInput | null): Terrain {
  if (profile.race?.type) return profile.race.type;
  if (snapshot) {
    const { road, trail } = snapshot.roadTrailMix;
    if (trail > road * 1.5) return 'trail';
    if (trail > 0 && road > 0) return 'mixed';
  }
  return 'road';
}

/**
 * Produce the full RenderParams for the renderer. Deterministic — pure function
 * of (profile, snapshot, caps, template). See the file header for the algorithm.
 */
export function computeRenderParams(
  profile: SelectorProfile,
  snapshot: FitnessSnapshotInput | null,
  caps: SafetyCaps,
  template: PlanTemplate,
): RenderParams {
  const tier = profile.experienceTier;
  const distance = profile.goalDistance;
  const templateId = template.id;

  // 1. Timeline. Open-ended for day-to-day, keep_fit, or an intended goal with
  //    no date yet; otherwise the whole weeks between today and the target.
  let totalWeeks: number | null;
  if (profile.goalState === 'day_to_day' || distance === 'keep_fit' || !profile.targetDate) {
    totalWeeks = null;
  } else {
    totalWeeks = clampInt(
      whole_weeks_between(profile.today, profile.targetDate),
      MIN_PLAN_WEEKS,
      MAX_PLAN_WEEKS,
    );
  }

  // Injury accommodations + the light volume reduction they imply. Folding the
  // reduction into the volume params here (rather than scaling each day later)
  // keeps the ramp clean and in-bounds; the overlay handles the day-type swaps.
  const injuryAccommodations = profile.injuries.map((i) => toInjuryAccommodation(i.bodyPart));
  const injuryReduce =
    profile.injuries.length > 0 && template.supportsOverlays.includes('injury')
      ? injuryAccommodations.reduce((m, a) => Math.max(m, a.reduceVolumePct ?? 0), 0)
      : 0;
  const volScale = 1 - injuryReduce;

  // 2. Volume. Start at the athlete's recent mileage, floored to the template's
  //    minimum; peak is the template ceiling, bounded by a multiple of the start.
  const recent = snapshot?.recentWeeklyMileageMi ?? 0;
  const startVolumeMi = round1(Math.max(recent, template.volume.startVolumeFloorMi) * volScale);
  const peakVolumeMi = round1(
    Math.min(template.volume.peakVolumeCapMi, startVolumeMi * template.volume.peakMultiplierMax),
  );

  // 3. Long run. Anchor to the Strava longest run (or a fraction of the start),
  //    capped to the lesser of the template ceiling and the per-distance cap.
  const longRunCapMi = Math.min(
    template.volume.longRun.capMi,
    caps.maxLongRunMiByDistance[distance],
  );
  const anchor = template.volume.longRun.startAnchor;
  let startLongRunMi =
    anchor === 'strava_longest' && snapshot?.longestRunMi
      ? snapshot.longestRunMi * volScale
      : startVolumeMi * (template.volume.longRun.startFraction ?? 0.3);
  startLongRunMi = round1(Math.max(3, Math.min(startLongRunMi, longRunCapMi)));

  // 4. Run days — clamp the athlete's choice into the template's supported range.
  const microKeys = Object.keys(template.microcycles)
    .map(Number)
    .sort((a, b) => a - b);
  const runsPerWeek = clampInt(
    profile.daysPerWeek,
    microKeys[0] ?? 3,
    microKeys[microKeys.length - 1] ?? 5,
  );

  // 5. Strength — default by tier (opt-out is applied upstream of the renderer).
  const strengthSessionsPerWeek = template.strength.defaultSessionsByTier[tier];

  // 6. Time-goal gating + overlays.
  const elig = timeGoalEligibility(templateId, tier);
  const wantsTime = profile.targetType === 'time' && profile.targetTimeSec != null;
  const timeGoalActive =
    wantsTime && elig.eligible && template.supportsOverlays.includes('time_goal');

  const terrain = deriveTerrain(profile, snapshot);
  const trailLeaning =
    profile.race?.type === 'trail' ||
    (snapshot != null && snapshot.roadTrailMix.trail > snapshot.roadTrailMix.road);

  const overlays: OverlayKind[] = [];
  if (trailLeaning && template.supportsOverlays.includes('trail')) overlays.push('trail');
  if (timeGoalActive) overlays.push('time_goal');
  if (profile.injuries.length > 0 && template.supportsOverlays.includes('injury')) {
    overlays.push('injury');
  }
  if (totalWeeks === null && template.supportsOverlays.includes('open_ended')) {
    overlays.push('open_ended');
  }

  // 7. Race (committed) or null (intended / day-to-day → renderer synthesizes a
  //    placeholder, since PlanSchema requires metadata.race).
  const race: RenderRace | null = profile.race
    ? {
        name: profile.race.name,
        date: profile.race.date,
        distanceMiles: profile.race.distanceMiles,
        ...(profile.race.elevationGainFt != null
          ? { elevationGainFt: profile.race.elevationGainFt }
          : {}),
        type: profile.race.type,
        targetType: profile.targetType,
        ...(timeGoalActive && profile.targetTimeSec != null
          ? { targetTimeSec: profile.targetTimeSec }
          : {}),
      }
    : null;

  // 8. Known gaps. Persistence is W5 — at gen time equipment is unknown
  //    (→ bodyweight) and we record the gaps still open for the daily coach.
  const strengthEquipment: StrengthEquipment = 'unknown';
  const openKnownGaps: KnownGapKey[] = ['strength_equipment'];
  if (!timeGoalActive && elig.eligible) openKnownGaps.push('target_time');
  if (snapshot == null) openKnownGaps.push('recent_long_run');

  return {
    templateId,
    tier,
    distance,
    terrain,
    startDate: profile.today,
    totalWeeks,
    race,
    startVolumeMi,
    peakVolumeMi,
    startLongRunMi,
    longRunCapMi,
    runsPerWeek,
    strengthSessionsPerWeek,
    longRunDay: profile.longRunDay,
    targetType: profile.targetType,
    targetTimeSec: timeGoalActive ? profile.targetTimeSec : null,
    timeGoalDiscouraged: timeGoalActive ? elig.discouraged : false,
    overlays,
    injuryAccommodations,
    caps,
    strengthEquipment,
    openKnownGaps,
  };
}

// Exported for the renderer's placeholder-race synthesis and validateSafety's
// distance-bucket fallback (keep in sync with DISTANCE_MILES).
export function nominalRaceMiles(distance: GoalDistance): number {
  return DISTANCE_MILES[distance];
}
