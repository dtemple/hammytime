// Plan renderer (onboarding v2, W3).
//
// Deterministically expands a (template + params) into a schema-valid `Plan`.
// No LLM in this path: initial plan-gen runs inline on the bot path for an
// instant B1 preview, and the output is always PlanSchema-valid. The worker
// coach agent customizes on top later (the [Adjust it] path), reading this Plan
// as a file.
//
// Pipeline: allocatePhases → buildWeeks → placeStrength → assemble → applyOverlays
// → PlanSchema.parse. `validateSafety` is a separate detector the CALLER runs
// (gen-time: a bug-catcher that should pass; chat-time: drives an advisory
// warning). The renderer builds WITHIN the caps by construction, so a generated
// plan passes validateSafety; it never refuses to produce a plan.

import { PlanSchema } from '@/lib/plan-schema';
import type { Day, PhaseName, Plan, Week } from '@/lib/plan-schema';
import type {
  GoalDistance,
  PlanTemplate,
  RenderParams,
  RunRole,
  SafetyCaps,
  WorkoutSpec,
} from './types';
import { nominalRaceMiles } from './selector';
import { addDays, mondayOf, weekdayOf } from './dates';

type AgentGuidance = NonNullable<Plan['agent_guidance']>;
type ComplianceRule = NonNullable<AgentGuidance['compliance_rules']>[number];
type PaceZones = NonNullable<AgentGuidance['pace_zones']>;
type PaceZone = PaceZones['easy'];

// Open-ended horizon (no race date): a starting block of base+build only. 12
// weeks for an intended goal (matches the B1 preview "~12 weeks out"); a shorter
// rolling block for pure maintenance.
const OPEN_ENDED_WEEKS = 12;
const OPEN_ENDED_MAINTENANCE_WEEKS = 8;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Monday-first display order (matches the canonical plan).
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const HARD_TYPES = new Set<Day['type']>([
  'long_run',
  'tempo',
  'trail_tempo',
  'intervals',
  'hill_repeats',
]);

// ---------------------------------------------------------------------------
// Date helpers — ISO yyyy-mm-dd, UTC anchored. addDays/mondayOf/weekdayOf live in
// ./dates (shared with the selector); the small grid helpers stay local.
// ---------------------------------------------------------------------------

function offsetFromMonday(weekday: number): number {
  return weekday === 0 ? 6 : weekday - 1;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

function floorHalf(n: number): number {
  return Math.floor(n * 2) / 2;
}

// ---------------------------------------------------------------------------
// Phase allocation.
// ---------------------------------------------------------------------------

export interface PhaseAllocation {
  weekNumber: number;
  phase: PhaseName; // includes 'cutback' once relabeled
  isCutback: boolean;
  /** The structural phase the week belongs to even when relabeled cutback
   *  (so volume/long-run ramp can keep flowing through a down week). */
  basePhase: Exclude<PhaseName, 'cutback'>;
}

/**
 * Allocate weeks across the template's phases by weight (honoring min/max), then
 * relabel every Nth base/build/peak week as a cutback. Open-ended (totalWeeks
 * null) emits only the openEndedKeep phases over a fixed horizon.
 */
export function allocatePhases(template: PlanTemplate, params: RenderParams): PhaseAllocation[] {
  const openEnded = params.totalWeeks === null;
  const phases = openEnded ? template.phases.filter((p) => p.openEndedKeep) : template.phases;
  const weeks = openEnded
    ? template.band === 'maintenance'
      ? OPEN_ENDED_MAINTENANCE_WEEKS
      : OPEN_ENDED_WEEKS
    : params.totalWeeks!;

  const counts = allocateCounts(phases, weeks);

  const allocation: PhaseAllocation[] = [];
  let weekNumber = 1;
  phases.forEach((phase, i) => {
    for (let k = 0; k < counts[i]!; k++) {
      const isCutback =
        weekNumber > 1 &&
        weekNumber % template.cutback.everyNWeeks === 0 &&
        (phase.name === 'base' || phase.name === 'build' || phase.name === 'peak');
      allocation.push({
        weekNumber,
        phase: isCutback ? 'cutback' : phase.name,
        isCutback,
        basePhase: phase.name,
      });
      weekNumber++;
    }
  });
  return allocation;
}

/** Spread `remainder` extra weeks across phases[startIdx..] by weight, honoring
 *  maxWeeks: each step goes to the phase furthest below its weighted target, skipping
 *  any that have hit maxWeeks. Mutates `counts`. Assumes a surviving un-capped phase
 *  (every template has an un-capped `build`) to absorb spill; if every candidate is
 *  capped, any leftover is dropped rather than overflowing a cap. */
function distributeByWeight(
  phases: PlanTemplate['phases'],
  counts: number[],
  remainder: number,
  startIdx = 0,
): void {
  const totalWeight = phases.reduce((s, p) => s + p.weight, 0) || 1;
  while (remainder > 0) {
    let best = -1;
    let bestRatio = Infinity;
    for (let i = startIdx; i < phases.length; i++) {
      const p = phases[i]!;
      if (p.maxWeeks != null && counts[i]! >= p.maxWeeks) continue;
      const ratio = (counts[i]! + 1) / (p.weight / totalWeight || 1e-9);
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = i;
      }
    }
    if (best < 0) break; // everything capped — leave the remainder off
    counts[best]!++;
    remainder--;
  }
}

function allocateCounts(phases: PlanTemplate['phases'], weeks: number): number[] {
  const n = phases.length;
  const minSum = phases.reduce((s, p) => s + p.minWeeks, 0);

  if (weeks >= minSum) {
    // Enough runway for every minimum: seed at minWeeks, spread the surplus by weight.
    const counts = phases.map((p) => p.minWeeks);
    distributeByWeight(phases, counts, weeks - minSum, 0);
    return counts;
  }

  // Over-compressed: fewer weeks than the phases' summed minimums, but at least one
  // per phase is affordable. Drop whole phases from the FRONT (base first, then
  // build, …) — keeping the tail incl. taper/race — until the survivors' minimums fit,
  // then seed survivors at minWeeks and spread any surplus by weight honoring maxWeeks.
  // This never overflows a capped phase, so `race` stays at exactly 1 week and last.
  if (weeks >= n) {
    const minSumFrom = (s: number) => phases.slice(s).reduce((acc, p) => acc + p.minWeeks, 0);
    let start = 0;
    while (start < n - 1 && minSumFrom(start) > weeks) start++;

    const counts = phases.map(() => 0);
    let budget = weeks;
    for (let i = start; i < n; i++) {
      const give = Math.min(phases[i]!.minWeeks, budget); // partial only in the extreme
      counts[i] = give;
      budget -= give;
    }
    distributeByWeight(phases, counts, budget, start);
    return counts;
  }

  // Extreme: fewer weeks than phases. Keep the last `weeks` phases (taper/race
  // win — arriving rested matters more than a full base). Never silently emit
  // a zero-length plan; 1 each honors every maxWeeks (all are >= 1).
  const counts = phases.map(() => 0);
  for (let i = n - weeks; i < n; i++) counts[i] = 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Week construction.
// ---------------------------------------------------------------------------

interface WeekVolume {
  totalMi: number;
  longRunMi: number;
}

/** Per-week volume + long-run progression, ramping within the caps. Cutback
 *  weeks step down; taper/race shed volume; the underlying trend keeps flowing
 *  so the week after a cutback resumes the build (not the cutback low). */
function rampVolumes(
  template: PlanTemplate,
  params: RenderParams,
  allocation: PhaseAllocation[],
): WeekVolume[] {
  const { caps } = params;
  const upIdx = allocation
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => !a.isCutback && a.basePhase !== 'taper' && a.basePhase !== 'race')
    .map(({ i }) => i);
  const nUp = upIdx.length;
  const linStep = nUp > 1 ? (params.peakVolumeMi - params.startVolumeMi) / (nUp - 1) : 0;

  // Long-run progression is stretched across the base+build phases (reaching the
  // ceiling at the end of the build) and then HELD at the ceiling through the
  // peak phase — so the longest runs land in the final block, not mid-build. The
  // per-week step is capped by the template's weeklyStepMi, so a short plan still
  // ramps no faster than the cap (it just reaches the ceiling later / not at all).
  const buildUpCount = allocation.filter(
    (a) => !a.isCutback && (a.basePhase === 'base' || a.basePhase === 'build'),
  ).length;
  const lrRampStep = Math.min(
    template.volume.longRun.weeklyStepMi,
    buildUpCount > 1
      ? (params.longRunCapMi - params.startLongRunMi) / (buildUpCount - 1)
      : template.volume.longRun.weeklyStepMi,
  );

  const out: WeekVolume[] = new Array(allocation.length);

  // Trend that flows through cutbacks (cutback weeks don't advance it).
  let trendVol = params.startVolumeMi;
  let trendLr = params.startLongRunMi;
  let upCount = 0;
  let lastTrendVol = params.startVolumeMi;
  let lastTrendLr = params.startLongRunMi;
  let prevWasCutback = false;
  let prevEmitted: WeekVolume | null = null;

  const lrCap = params.longRunCapMi;

  allocation.forEach((a, i) => {
    if (a.isCutback) {
      const cutTotal = roundHalf(trendVol * template.cutback.volumePct);
      out[i] = {
        totalMi: cutTotal,
        // The down week cuts total volume more than the long run, so clamp the
        // long run to its share of the (smaller) week too — else share creeps up.
        longRunMi: floorHalf(
          Math.min(trendLr * 0.7, lrCap, caps.maxLongRunShareOfWeekly * cutTotal),
        ),
      };
      prevWasCutback = true;
      prevEmitted = out[i]!;
      return;
    }

    if (a.basePhase === 'taper' || a.basePhase === 'race') {
      // Position within the taper→race tail: shed volume toward race day.
      out[i] = taperRace(a, allocation, lastTrendVol, lastTrendLr, params);
      prevWasCutback = false;
      prevEmitted = out[i]!;
      return;
    }

    // Up-trend week.
    if (upCount === 0) {
      trendVol = params.startVolumeMi;
      trendLr = params.startLongRunMi;
    } else {
      const capStep = Math.max(trendVol * caps.maxWeeklyRampPct, caps.minWeeklyRampMi);
      trendVol = Math.min(params.peakVolumeMi, trendVol + Math.min(linStep, capStep));
      // Long run climbs through base/build, then holds at the ceiling in peak.
      trendLr = a.basePhase === 'peak' ? lrCap : Math.min(lrCap, trendLr + lrRampStep);
    }
    upCount++;

    let totalMi = roundHalf(trendVol);
    let longRunMi = trendLr;

    // Clamp the EMITTED (rounded) increase to the cap vs the previous emitted
    // up-week — floored to the half-mile grid so rounding can never push a step
    // over the cap and trip validateSafety. Re-ramping out of a cutback is
    // exempt (the validator skips it too).
    if (prevEmitted && !prevWasCutback) {
      const maxTotal = floorHalf(
        prevEmitted.totalMi +
          Math.max(prevEmitted.totalMi * caps.maxWeeklyRampPct, caps.minWeeklyRampMi),
      );
      totalMi = Math.min(totalMi, maxTotal);
      longRunMi = Math.min(longRunMi, prevEmitted.longRunMi + caps.maxLongRunStepMi);
    }
    longRunMi = floorHalf(Math.min(longRunMi, lrCap, caps.maxLongRunShareOfWeekly * totalMi));

    out[i] = { totalMi, longRunMi };
    lastTrendVol = trendVol;
    lastTrendLr = trendLr;
    prevWasCutback = false;
    prevEmitted = out[i]!;
  });

  return out;
}

function taperRace(
  a: PhaseAllocation,
  allocation: PhaseAllocation[],
  lastTrendVol: number,
  lastTrendLr: number,
  params: RenderParams,
): WeekVolume {
  const tail = allocation.filter((x) => x.basePhase === 'taper' || x.basePhase === 'race');
  const pos = tail.findIndex((x) => x.weekNumber === a.weekNumber);
  const n = tail.length;
  if (a.basePhase === 'race') {
    // Race week: a short shakeout total; the "long run" slot becomes the race.
    return { totalMi: roundHalf(lastTrendVol * 0.3), longRunMi: 0 };
  }
  // Taper weeks: linear from ~75% down to ~55% of peak.
  const frac = n <= 1 ? 0.7 : 0.75 - (0.2 * pos) / (n - 1);
  const totalMi = roundHalf(lastTrendVol * frac);
  const longRunMi = floorHalf(
    Math.min(
      lastTrendLr * frac,
      params.longRunCapMi,
      params.caps.maxLongRunShareOfWeekly * totalMi,
    ),
  );
  return { totalMi, longRunMi };
}

/** Expand each allocated week into a 7-day `Week`. Strength is layered later by
 *  placeStrength; here non-run slots are rest. */
export function buildWeeks(
  template: PlanTemplate,
  params: RenderParams,
  allocation: PhaseAllocation[],
): Plan['weeks'] {
  const volumes = rampVolumes(template, params, allocation);
  // Anchor a committed plan so its LAST week is the race week and the race day lands on
  // the real date; intended/open-ended plans (no committed race) keep starting from
  // today's week. The inclusive week count (selector) makes the unclamped anchor equal
  // mondayOf(today); a far race clamped to MAX_PLAN_WEEKS starts later, still ending on
  // race day.
  const anchored = params.totalWeeks !== null && params.race != null;
  const planMonday = anchored
    ? addDays(mondayOf(params.race!.date), -(allocation.length - 1) * 7)
    : mondayOf(params.startDate);
  const raceSlotWeekday = anchored ? weekdayOf(params.race!.date) : params.longRunDay;
  const pattern = microcycleFor(template, params.runsPerWeek);

  return allocation.map((alloc, wi) => {
    const vol = volumes[wi]!;
    const weekMonday = addDays(planMonday, wi * 7);
    const isRaceWeek = alloc.basePhase === 'race';
    // Ease-in: an athlete who onboards mid-week shouldn't be told to run hard on a day
    // that's already gone, or on the sign-up day itself. When week 1 actually contains the
    // sign-up day (the common case — a far race clamped to MAX_PLAN_WEEKS starts in the
    // future, so its week 1 does not), rest the elapsed days + the sign-up day and keep the
    // remainder to easy warm-up runs. The coach reasons about how to use the rest of the
    // week from here; this is just the safe baseline the preview shows.
    const isEaseInWeek =
      params.easeIn !== false &&
      wi === 0 &&
      params.startDate >= weekMonday &&
      params.startDate <= addDays(weekMonday, 6);

    const roleByWeekday = assignWeekdays(
      pattern,
      params.longRunDay,
      params.caps.minEasyDaysBetweenHard,
    );

    // Distance per run day. The non-long runs are distributed to sum EXACTLY to
    // the non-long budget (last one absorbs the rounding), so the week total
    // equals the trend total the long-run share was clamped against — otherwise
    // rounding losses would push the long run over its share cap.
    const nonLongWeekdays = DISPLAY_ORDER.filter(
      (wd) =>
        roleByWeekday[wd] !== undefined &&
        roleByWeekday[wd] !== 'long_run' &&
        !(isRaceWeek && wd === raceSlotWeekday),
    );
    const nonLongBudget = Math.max(0, vol.totalMi - vol.longRunMi);
    const per = nonLongWeekdays.length > 0 ? roundHalf(nonLongBudget / nonLongWeekdays.length) : 0;
    const distByWeekday: Record<number, number> = {};
    let acc = 0;
    nonLongWeekdays.forEach((wd, idx) => {
      const d =
        idx === nonLongWeekdays.length - 1 ? Math.max(0, roundHalf(nonLongBudget - acc)) : per;
      distByWeekday[wd] = d;
      acc += d;
    });

    // Resolve quality workouts for this week's phase (skip on race week). Taper
    // weeks keep a SINGLE short sharpener (a tempo, per the workout menu) — the
    // rest of the quality slots drop to easy so the athlete arrives fresh.
    const qualityWorkouts = isRaceWeek ? [] : eligibleWorkouts(template, alloc.basePhase);
    const maxQuality = alloc.basePhase === 'taper' ? 1 : Infinity;
    let qualityUsed = 0;

    const days: Day[] = DISPLAY_ORDER.map((weekday) => {
      const date = addDays(weekMonday, offsetFromMonday(weekday));
      const dayName = WEEKDAYS[weekday]!;
      const role = roleByWeekday[weekday];
      const miles = distByWeekday[weekday] ?? 0;

      if (isRaceWeek) {
        // Place the race on its real date (anchored) — checked first and
        // unconditionally so a race on a rest-day weekday still lands. Days after the
        // race in the race week are recovery. Non-anchored (placeholder) plans keep
        // the race on the long-run day.
        if (anchored) {
          if (date === params.race!.date) return raceDay(dayName, date, params);
          if (date > params.race!.date) {
            return {
              day: dayName,
              date,
              type: 'rest',
              category: 'rest',
              description: 'Recover — the race is done.',
            };
          }
        } else if (weekday === params.longRunDay) {
          return raceDay(dayName, date, params);
        }
      }
      if (isEaseInWeek) {
        // Past the race-week check above (a 1-week plan can be both), so the race day is
        // already placed. Rest the elapsed days and the sign-up day; the remainder is easy
        // warm-up runs only — no long run, no quality.
        if (date < params.startDate) {
          return { day: dayName, date, type: 'rest', category: 'rest', description: 'Rest day.' };
        }
        if (date === params.startDate) {
          return {
            day: dayName,
            date,
            type: 'rest',
            category: 'rest',
            description: "Rest today; we'll ease in from here.",
          };
        }
        if (role === undefined) {
          return { day: dayName, date, type: 'rest', category: 'rest', description: 'Rest day.' };
        }
        if (role === 'long_run') {
          return {
            day: dayName,
            date,
            type: 'rest',
            category: 'rest',
            description: 'Easy week to start — long runs pick up in week 2.',
          };
        }
        return easyDayEntry(dayName, date, miles, 'easy', template);
      }
      if (role === undefined) {
        return { day: dayName, date, type: 'rest', category: 'rest', description: 'Rest day.' };
      }
      if (role === 'long_run') {
        // No long run in the race week — the race is the long effort (its long-run
        // volume is already 0), so the slot is rest/shakeout.
        if (isRaceWeek) {
          return {
            day: dayName,
            date,
            type: 'rest',
            category: 'rest',
            description: 'Easy or rest — race week.',
          };
        }
        return longRunDayEntry(dayName, date, vol.longRunMi, template, params, alloc);
      }
      if (role === 'quality') {
        const workout =
          qualityWorkouts.length && qualityUsed < maxQuality
            ? qualityWorkouts[qualityUsed % qualityWorkouts.length]!
            : null;
        if (workout) {
          qualityUsed++;
          return qualityDay(dayName, date, miles, workout, template, alloc);
        }
        return easyDayEntry(dayName, date, miles, 'easy_with_strides', template);
      }
      return easyDayEntry(dayName, date, miles, role, template);
    });

    // Run-mileage total (excludes the race day, which is the goal effort, not
    // training volume) — kept equal to the trend total on non-race weeks.
    const runTotal = isRaceWeek
      ? roundHalf(
          days
            .filter((d) => d.type !== 'race')
            .reduce((s, d) => s + (d.planned_distance_miles ?? 0), 0),
        )
      : vol.totalMi;

    return {
      week_number: alloc.weekNumber,
      start_date: weekMonday,
      end_date: addDays(weekMonday, 6),
      phase: alloc.phase,
      planned_total_run_miles: runTotal,
      coaching_note: isEaseInWeek ? easeInNote(params, weekMonday) : weekNote(alloc, template),
      days,
    } satisfies Week;
  });
}

function microcycleFor(template: PlanTemplate, runsPerWeek: number): RunRole[] {
  const keys = Object.keys(template.microcycles)
    .map(Number)
    .sort((a, b) => a - b);
  const key = keys.includes(runsPerWeek)
    ? runsPerWeek
    : keys.reduce(
        (best, k) => (Math.abs(k - runsPerWeek) < Math.abs(best - runsPerWeek) ? k : best),
        keys[0]!,
      );
  return template.microcycles[key]!;
}

/** Assign run roles to weekdays: long run on its day, quality days spaced as far
 *  as possible from other hard days, easy runs in the remainder, rest elsewhere. */
function assignWeekdays(
  pattern: RunRole[],
  longRunDay: number,
  minEasyBetweenHard: number,
): Record<number, RunRole> {
  void minEasyBetweenHard; // greedy farthest-point placement maximizes spacing
  const out: Record<number, RunRole> = {};
  const used = new Set<number>();

  out[longRunDay] = 'long_run';
  used.add(longRunDay);
  const hardDays = [longRunDay];

  const circDist = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return Math.min(d, 7 - d);
  };

  const qualityCount = pattern.filter((r) => r === 'quality').length;
  for (let q = 0; q < qualityCount; q++) {
    let best = -1;
    let bestScore = -1;
    for (let wd = 0; wd < 7; wd++) {
      if (used.has(wd)) continue;
      const minToHard = Math.min(...hardDays.map((h) => circDist(wd, h)));
      // Prefer the slot maximizing distance to the nearest hard day.
      if (minToHard > bestScore) {
        bestScore = minToHard;
        best = wd;
      }
    }
    if (best < 0) break;
    out[best] = 'quality';
    used.add(best);
    hardDays.push(best);
  }

  // Remaining run roles (easy / easy_with_strides) into the open weekdays,
  // preferring days away from hard days so easy stays recovery.
  const easyRoles = pattern.filter((r) => r !== 'long_run' && r !== 'quality');
  const openDays = [...Array(7).keys()]
    .filter((wd) => !used.has(wd))
    .sort((a, b) => {
      const da = Math.min(...hardDays.map((h) => circDist(a, h)));
      const db = Math.min(...hardDays.map((h) => circDist(b, h)));
      return db - da;
    });
  easyRoles.forEach((role, idx) => {
    const wd = openDays[idx];
    if (wd !== undefined) {
      out[wd] = role;
      used.add(wd);
    }
  });

  return out;
}

function eligibleWorkouts(
  template: PlanTemplate,
  phase: Exclude<PhaseName, 'cutback'>,
): WorkoutSpec[] {
  const eligible = template.workoutMenu.filter(
    (w) => w.dayType !== 'easy_with_strides' && w.phases.includes(phase),
  );
  return eligible;
}

// ---------------------------------------------------------------------------
// Day builders.
// ---------------------------------------------------------------------------

function zone(template: PlanTemplate, key: keyof PaceZones): PaceZone | undefined {
  const z = template.guidanceBase.pace_zones?.[key];
  return z && typeof z === 'object' && 'hr_zone' in z ? (z as PaceZone) : undefined;
}

function effortFields(template: PlanTemplate, key: keyof PaceZones): Partial<Day> {
  const z = zone(template, key) ?? zone(template, 'easy');
  if (!z) return {};
  return { target_hr_zone: z.hr_zone, target_rpe: z.rpe };
}

function longRunDayEntry(
  day: string,
  date: string,
  miles: number,
  template: PlanTemplate,
  params: RenderParams,
  alloc: PhaseAllocation,
): Day {
  const longRace = params.distance === 'marathon' || params.distance === 'half';
  const practiceNutrition = longRace && alloc.weekNumber >= 9 && miles >= 12;
  return {
    day,
    date,
    type: 'long_run',
    category: 'run',
    description: `Long run — ${miles} mi easy. Time on feet; keep it conversational.`,
    planned_distance_miles: miles,
    intensity: 'easy',
    ...effortFields(template, 'long_run'),
    ...(practiceNutrition
      ? { nutrition_practice: true, nutrition_note: 'Practice race-day fueling and hydration.' }
      : {}),
  };
}

function easyDayEntry(
  day: string,
  date: string,
  miles: number,
  role: RunRole,
  template: PlanTemplate,
): Day {
  if (role === 'easy_with_strides') {
    const stridesSpec = template.workoutMenu.find(
      (w) => w.dayType === 'easy_with_strides',
    )?.strides;
    const strides: NonNullable<Day['strides']> = stridesSpec
      ? {
          count: stridesSpec.count,
          duration_sec: stridesSpec.durationSec,
          recovery: stridesSpec.recovery,
        }
      : { count: [4, 6], duration_sec: 20, recovery: 'full jog back' };
    return {
      day,
      date,
      type: 'easy_with_strides',
      category: 'run',
      description: `Easy ${miles} mi + ${strides.count[0]}–${strides.count[1]}×${strides.duration_sec}s strides.`,
      planned_distance_miles: miles,
      intensity: 'easy',
      strides,
      ...effortFields(template, 'easy'),
    };
  }
  return {
    day,
    date,
    type: 'easy',
    category: 'run',
    description: `Easy ${miles} mi — conversational pace.`,
    planned_distance_miles: miles,
    intensity: 'easy',
    ...effortFields(template, 'easy'),
  };
}

function progress(range: [number, number], phase: Exclude<PhaseName, 'cutback'>): number {
  const factor = phase === 'peak' ? 1 : phase === 'build' ? 0.6 : 0.3;
  return Math.round(range[0] + (range[1] - range[0]) * factor);
}

function qualityDay(
  day: string,
  date: string,
  miles: number,
  workout: WorkoutSpec,
  template: PlanTemplate,
  alloc: PhaseAllocation,
): Day {
  const zoneKey: keyof PaceZones =
    workout.dayType === 'intervals'
      ? 'interval'
      : workout.dayType === 'hill_repeats'
        ? 'hill_repeat'
        : 'tempo';
  const base: Day = {
    day,
    date,
    type: workout.dayType,
    category: 'run',
    description: workout.description,
    planned_distance_miles: miles,
    intensity:
      workout.dayType === 'tempo' || workout.dayType === 'trail_tempo' ? 'moderate_hard' : 'hard',
    ...effortFields(template, zoneKey),
  };
  if (workout.warmupMin != null) base.warmup_min = workout.warmupMin;
  if (workout.cooldownMin != null) base.cooldown_min = workout.cooldownMin;
  if (workout.repeats) base.repeats = progress(workout.repeats, alloc.basePhase);
  if (workout.repeatDurationSec != null) base.repeat_duration_sec = workout.repeatDurationSec;
  if (workout.repeatDistanceM != null) base.repeat_distance_m = workout.repeatDistanceM;
  if (workout.recovery != null) base.recovery = workout.recovery;
  if (workout.tempoBlockMin)
    base.tempo_block_min = progress(workout.tempoBlockMin, alloc.basePhase);
  if (workout.strides) {
    base.strides = {
      count: workout.strides.count,
      duration_sec: workout.strides.durationSec,
      recovery: workout.strides.recovery,
    };
  }
  return base;
}

function raceDay(day: string, date: string, params: RenderParams): Day {
  const miles = params.race?.distanceMiles ?? nominalRaceMiles(params.distance);
  return {
    day,
    date,
    type: 'race',
    category: 'race',
    description: `Race day — ${params.race?.name ?? 'goal race'}.`,
    planned_distance_miles: miles,
    ...(params.race?.elevationGainFt != null
      ? { elevation_gain_ft: params.race.elevationGainFt }
      : {}),
    target_strategy:
      params.targetType === 'time' && params.targetTimeSec
        ? 'Run your goal pace; bank nothing early.'
        : 'Start conservative, finish strong.',
  };
}

function weekNote(alloc: PhaseAllocation, template: PlanTemplate): string {
  if (alloc.isCutback) return 'Down week — cut volume ~20% and absorb the work.';
  const phase = template.phases.find((p) => p.name === alloc.basePhase);
  return phase?.description ?? '';
}

/** Week-1 note when the athlete onboarded partway through the week. Carries the facts the
 *  coach reasons from (mid-week start, week 2 is the first full week); the coach decides how
 *  to use the days that remain. */
function easeInNote(params: RenderParams, weekMonday: string): string {
  const hasRemainder = params.startDate < addDays(weekMonday, 6);
  return hasRemainder
    ? "Ease-in week. You're starting partway through the week, so the rest of it stays easy. " +
        'Long runs and harder sessions start in week 2, your first full week.'
    : "Ease-in week. You're joining at the end of the week, so this week is rest. Week 2 is " +
        'your first full week.';
}

// ---------------------------------------------------------------------------
// Strength placement.
// ---------------------------------------------------------------------------

/** Slot strength sessions onto non-run (rest) weekdays without consuming run
 *  days, up to params.strengthSessionsPerWeek, clamped to available slots.
 *  Sessions stay bodyweight while strengthEquipment is 'unknown'. */
export function placeStrength(
  weeks: Plan['weeks'],
  template: PlanTemplate,
  params: RenderParams,
): Plan['weeks'] {
  const want = params.strengthSessionsPerWeek;
  if (want === 0) return weeks;
  const sessionOrder: Array<'lower_body' | 'upper_body'> = ['lower_body', 'upper_body'];

  return weeks.map((week) => {
    const isTaper = week.phase === 'taper';
    const isRace = week.phase === 'race';
    // The ease-in week is the one containing the sign-up day (a clamped far-race plan
    // starts in the future, so no week contains it). Its elapsed days and the sign-up day
    // are rest by design — don't fill them with strength.
    const isEaseIn =
      week.start_date != null &&
      week.end_date != null &&
      params.startDate >= week.start_date &&
      params.startDate <= week.end_date;

    // Don't slot strength onto days AFTER the race in the race week (that's recovery,
    // not training); pre-race rest days still take a light race-week session. In the
    // ease-in week, skip the elapsed days and the sign-up day too.
    const restWeekdays = week.days
      .map((d, idx) => ({ d, idx }))
      .filter(
        ({ d }) =>
          d.type === 'rest' &&
          !(isRace && params.race != null && d.date != null && d.date > params.race.date) &&
          !(isEaseIn && d.date != null && d.date <= params.startDate),
      )
      .map(({ idx }) => idx);
    const slots = restWeekdays.slice(0, want);

    const days = [...week.days];
    slots.forEach((dayIdx, s) => {
      const which = sessionOrder[s % sessionOrder.length]!;
      const session = template.strength.sessions[which];
      if (!session) return;
      const type = which === 'lower_body' ? 'lower_body_strength' : 'upper_body_strength';
      const duration = isRace
        ? session.race_week_duration_min
        : isTaper
          ? session.taper_duration_min
          : session.standard_duration_min;
      const intensity = isRace ? 'race_week' : isTaper ? 'taper' : 'standard';
      days[dayIdx] = {
        day: days[dayIdx]!.day,
        date: days[dayIdx]!.date,
        type,
        category: 'strength',
        description: `${which === 'lower_body' ? 'Lower body' : 'Upper body'} + core — ${duration} min (bodyweight).`,
        planned_duration_min: duration,
        intensity_level: intensity,
        ...(isTaper || isRace ? { use_taper_sets: true } : {}),
      };
    });

    return { ...week, days };
  });
}

// ---------------------------------------------------------------------------
// Assemble + overlays.
// ---------------------------------------------------------------------------

function buildComplianceRules(params: RenderParams, base: ComplianceRule[]): ComplianceRule[] {
  const { caps, distance } = params;
  const pct = Math.round(caps.maxWeeklyRampPct * 100);
  const capsRules: ComplianceRule[] = [
    {
      rule_id: 'long_run_progression',
      description: `Long run should not jump more than ${caps.maxLongRunStepMi} miles week over week.`,
      max_increase_miles: caps.maxLongRunStepMi,
      exception: `The week after a cutback may increase up to ${caps.postCutbackLongRunStepMi} miles.`,
      action:
        'If the athlete wants a bigger jump, warn about the injury risk and the tradeoff, ask them to confirm, then make the change.',
    },
    {
      rule_id: 'weekly_volume_cap',
      description: `Weekly mileage should not climb more than ${pct}% or ${caps.minWeeklyRampMi} mi (whichever is greater) week over week.`,
      threshold_percent: pct,
      exception:
        'Cutback weeks go down; re-ramping out of a cutback to the prior peak is expected.',
      action:
        'If the athlete asks for a faster ramp, warn clearly with the tradeoff, ask them to confirm, then apply it.',
    },
    {
      rule_id: 'long_run_distance_cap',
      description: `For this race distance the long run is capped at ${caps.maxLongRunMiByDistance[distance]} miles.`,
      target: `${caps.maxLongRunMiByDistance[distance]} mi`,
      action:
        'Going past this costs more recovery than it returns. If they want it, say so plainly, ask them to confirm, then write it.',
    },
  ];
  const capIds = new Set(capsRules.map((r) => r.rule_id));
  // Caps win on shared rule_id; keep template coaching-color rules.
  return [...capsRules, ...base.filter((r) => !capIds.has(r.rule_id))];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function assemblePlan(
  template: PlanTemplate,
  params: RenderParams,
  allocation: PhaseAllocation[],
  weeks: Plan['weeks'],
): Plan {
  const totalWeeks = weeks.length;
  const startMonday = weeks[0]?.start_date ?? mondayOf(params.startDate);
  const endDate = weeks[totalWeeks - 1]?.end_date ?? addDays(startMonday, totalWeeks * 7 - 1);

  // metadata.race — committed race, or a clearly-labeled placeholder (PlanSchema
  // requires it even when the athlete has no race yet).
  const race = params.race
    ? {
        name: params.race.name,
        date: params.race.date,
        distance_miles: params.race.distanceMiles,
        type: params.race.type,
        ...(params.race.elevationGainFt != null
          ? { elevation_gain_ft: params.race.elevationGainFt }
          : {}),
        ...(params.targetType === 'time' && params.race.targetTimeSec != null
          ? { goal: 'time', target_time_sec: params.race.targetTimeSec }
          : { goal: 'finish' }),
      }
    : {
        name:
          params.distance === 'keep_fit'
            ? 'Ongoing base — no race set'
            : `Goal ${params.distance} — date TBD`,
        date: endDate,
        distance_miles: nominalRaceMiles(params.distance),
        type: params.terrain,
        goal: 'finish',
        // Athlete-visible surfaces suppress placeholder races on this flag
        // (isPlaceholderRace in plan-schema.ts).
        placeholder: true,
      };

  // phases — group the allocation (covers weeks 1..N exactly once incl. cutback).
  const phaseOrder: PhaseName[] = ['base', 'build', 'cutback', 'peak', 'taper', 'race'];
  const phases = phaseOrder
    .map((name) => {
      const wks = allocation.filter((a) => a.phase === name).map((a) => a.weekNumber);
      if (wks.length === 0) return null;
      const desc =
        name === 'cutback'
          ? 'Recovery weeks — reduce volume to absorb the training.'
          : template.phases.find((p) => p.name === name)?.description;
      return { name, weeks: wks, ...(desc ? { description: desc } : {}) };
    })
    .filter((p): p is { name: PhaseName; weeks: number[]; description?: string } => p !== null);

  const restDay = weeks[0]?.days.find((d) => d.type === 'rest')?.day;

  const guidance: AgentGuidance = clone(template.guidanceBase);
  guidance.compliance_rules = buildComplianceRules(params, guidance.compliance_rules ?? []);

  const plan: Plan = {
    plan_version: 'template-1',
    metadata: {
      athlete: {
        baseline_weekly_miles: {
          min: Math.round(params.startVolumeMi),
          max: Math.round(params.peakVolumeMi),
        },
        baseline_long_run_miles: Math.round(params.startLongRunMi),
      },
      race,
      plan_structure: {
        total_weeks: totalWeeks,
        start_date: startMonday,
        end_date: endDate,
        days_per_week: Math.min(7, params.runsPerWeek + params.strengthSessionsPerWeek),
        ...(restDay ? { rest_day: restDay } : {}),
        runs_per_week: params.runsPerWeek,
        strength_sessions_per_week: params.strengthSessionsPerWeek,
        long_run_day: WEEKDAYS[params.longRunDay],
        phases,
      },
    },
    agent_guidance: guidance,
    weeks,
  };

  // strength_workouts — the exercise library, with the weekday each session lands
  // on (read off week 1's placed strength days).
  const strengthDays = (weeks[0]?.days ?? []).filter((d) => d.category === 'strength');
  const lower = strengthDays.find((d) => d.type === 'lower_body_strength');
  const upper = strengthDays.find((d) => d.type === 'upper_body_strength');
  const sw: NonNullable<Plan['strength_workouts']> = {};
  if (lower && template.strength.sessions.lower_body) {
    sw.lower_body = { day: lower.day, ...template.strength.sessions.lower_body };
  }
  if (upper && template.strength.sessions.upper_body) {
    sw.upper_body = { day: upper.day, ...template.strength.sessions.upper_body };
  }
  if (sw.lower_body || sw.upper_body) plan.strength_workouts = sw;

  return plan;
}

// ---------------------------------------------------------------------------
// Pace derivation (Riegel) — for pace-led templates with a time goal.
// ---------------------------------------------------------------------------

interface DerivedPaces {
  easy: [number, number];
  long: [number, number];
  tempo: [number, number];
  interval: [number, number];
  racePace: [number, number];
}

function riegelPaceSecPerMile(goalTimeSec: number, raceMi: number, targetMi: number): number {
  const t = goalTimeSec * Math.pow(targetMi / raceMi, 1.06);
  return t / targetMi;
}

function derivePaces(distance: GoalDistance, raceMi: number, goalTimeSec: number): DerivedPaces {
  const racePace = goalTimeSec / raceMi;
  const tempo = riegelPaceSecPerMile(goalTimeSec, raceMi, 6.2); // 10k-equiv
  const interval = riegelPaceSecPerMile(goalTimeSec, raceMi, 3.1); // 5k-equiv
  const easyOffset = distance === 'marathon' ? 75 : distance === 'half' ? 90 : 120;
  const easy = racePace + easyOffset;
  const band = (c: number, w: number): [number, number] => [Math.round(c - w), Math.round(c + w)];
  return {
    easy: band(easy + 22, 22),
    long: band(easy + 30, 25),
    tempo: band(tempo, 8),
    interval: band(interval, 8),
    racePace: band(racePace, 5),
  };
}

/**
 * Apply the overlays in params.overlays to a draft plan (pre-parse):
 *   • trail — prefer_trail/elevation on long runs, tempo→trail_tempo, power-hike +
 *     nutrition practice, lead on HR.
 *   • time_goal — concrete paces on zones + quality/long-run days (Riegel).
 *   • injury — light volume cut + avoid flagged day types.
 *   • open_ended — no-date framing in the guidance + week notes.
 */
export function applyOverlays(plan: Plan, params: RenderParams): Plan {
  const out = clone(plan);
  const has = (k: (typeof params.overlays)[number]) => params.overlays.includes(k);

  if (has('trail')) applyTrailOverlay(out);
  if (has('time_goal') && params.targetTimeSec) applyTimeGoalOverlay(out, params);
  if (has('injury')) applyInjuryOverlay(out, params);
  if (has('open_ended')) applyOpenEndedOverlay(out);

  return out;
}

function applyTrailOverlay(plan: Plan): void {
  const note = plan.agent_guidance?.pace_zones?.note;
  if (plan.agent_guidance?.pace_zones) {
    plan.agent_guidance.pace_zones.note = `${note ? note + ' ' : ''}Trail — lead with heart rate and effort; pace is unreliable on technical ground.`;
  }
  for (const week of plan.weeks) {
    for (const day of week.days) {
      if (day.type === 'long_run') {
        day.prefer_trail = true;
        day.include_elevation = true;
        if ((day.planned_distance_miles ?? 0) >= 12) {
          day.power_hike_practice = true;
          day.power_hike_note = 'Practice power-hiking the steep climbs — it’s a race skill.';
        }
      }
      if (day.type === 'tempo') {
        day.type = 'trail_tempo';
        day.description = day.description.replace(/tempo/i, 'trail tempo');
      }
    }
  }
}

function applyTimeGoalOverlay(plan: Plan, params: RenderParams): void {
  if (!params.targetTimeSec) return;
  const raceMi = params.race?.distanceMiles ?? nominalRaceMiles(params.distance);
  const paces = derivePaces(params.distance, raceMi, params.targetTimeSec);
  const pz = plan.agent_guidance?.pace_zones;
  if (pz) {
    if (pz.easy) pz.easy.pace_sec_per_mile = paces.easy;
    if (pz.long_run) pz.long_run.pace_sec_per_mile = paces.long;
    if (pz.tempo) pz.tempo.pace_sec_per_mile = paces.tempo;
    if (pz.interval) pz.interval.pace_sec_per_mile = paces.interval;
    if (pz.marathon_pace) pz.marathon_pace.pace_sec_per_mile = paces.racePace;
    pz.note = `${pz.note ? pz.note + ' ' : ''}Goal race pace ≈ ${fmtPace(paces.racePace)} /mi.`;
  }
  for (const week of plan.weeks) {
    if (week.phase !== 'build' && week.phase !== 'peak') continue;
    for (const day of week.days) {
      if (day.type === 'tempo' || day.type === 'trail_tempo')
        day.target_pace_sec_per_mile = paces.tempo;
      if (day.type === 'intervals') day.target_pace_sec_per_mile = paces.interval;
    }
  }
}

function fmtPace(band: [number, number]): string {
  const mid = Math.round((band[0] + band[1]) / 2);
  const m = Math.floor(mid / 60);
  const s = mid % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function applyInjuryOverlay(plan: Plan, params: RenderParams): void {
  // The volume reduction is already baked into the ramp (computeRenderParams).
  // Here we only keep flagged day types off the plan — swap them down to easy.
  const avoid = new Set<Day['type']>();
  for (const acc of params.injuryAccommodations) {
    (acc.avoidDayTypes ?? []).forEach((t) => avoid.add(t));
  }
  if (avoid.size === 0) return;
  for (const week of plan.weeks) {
    for (const day of week.days) {
      if (avoid.has(day.type)) {
        day.type = 'easy';
        day.intensity = 'easy';
        day.description = 'Easy run (swapped off a flagged session — injury accommodation).';
        delete day.warmup_min;
        delete day.cooldown_min;
        delete day.repeats;
        delete day.repeat_duration_sec;
        delete day.repeat_distance_m;
        delete day.recovery;
        delete day.tempo_block_min;
      }
    }
  }
}

function applyOpenEndedOverlay(plan: Plan): void {
  if (plan.agent_guidance) {
    plan.agent_guidance.description = `${plan.agent_guidance.description ? plan.agent_guidance.description + ' ' : ''}No race date locked yet — this is a base + build starting block; the peak and taper get added when a race anchors the calendar.`;
  }
  const first = plan.weeks[0];
  if (first) {
    first.coaching_note = `${first.coaching_note ? first.coaching_note + ' ' : ''}Starting point, not a contract — tell me the race whenever you pick it and I’ll anchor the calendar.`;
  }
}

// ---------------------------------------------------------------------------
// renderPlan — the composed pipeline.
// ---------------------------------------------------------------------------

/**
 * T-9 generation-time guard: a committed plan must contain exactly one `type:'race'`
 * day, on the real race date. Catches both the duplicate-race-day (T-1a) and
 * misplaced-race-day (T-1b) regressions and any future drift. Throws — this path is
 * inline on the bot and is meant to be deterministic and correct, so a wrong race date
 * should fail generation rather than get persisted. Skipped for intended/open-ended
 * plans, which carry a deliberately synthetic placeholder race (no real race day in the
 * grid). `metadata.race.date` equals `params.race.date` by construction, so checking the
 * race day against `params.race.date` is the load-bearing assertion.
 */
export function assertRaceDayInvariant(plan: Plan, params: RenderParams): void {
  if (!params.race) return;
  const raceDays = plan.weeks.flatMap((w) => w.days).filter((d) => d.type === 'race');
  if (raceDays.length !== 1) {
    throw new Error(
      `renderPlan: expected exactly one type:'race' day for a committed race, found ${raceDays.length}.`,
    );
  }
  const raceDate = raceDays[0]!.date;
  if (raceDate !== params.race.date) {
    throw new Error(
      `renderPlan: race day is ${raceDate ?? 'undated'} but the committed race is ${params.race.date}.`,
    );
  }
}

export function renderPlan(template: PlanTemplate, params: RenderParams): Plan {
  const allocation = allocatePhases(template, params);
  let weeks = buildWeeks(template, params, allocation);
  weeks = placeStrength(weeks, template, params);
  const draft = assemblePlan(template, params, allocation, weeks);
  const overlaid = applyOverlays(draft, params);
  const plan = PlanSchema.parse(overlaid);
  assertRaceDayInvariant(plan, params);
  return plan;
}

// ---------------------------------------------------------------------------
// Safety validator — DETECTS cap violations; it does not refuse. Policy is the
// caller's (gen-time: bug-catcher; chat-time: drives an advisory warning).
// ---------------------------------------------------------------------------

export interface SafetyViolation {
  rule: string; // 'weekly_ramp' | 'long_run_step' | 'hard_day_spacing' | 'long_run_cap' | 'long_run_share'
  week?: number;
  detail: string;
}

export interface SafetyResult {
  ok: boolean;
  violations: SafetyViolation[];
}

const EPS = 0.05; // tolerate half-mile rounding at the cap boundary

function distanceFromMiles(mi: number): GoalDistance {
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.2;
  if (near(mi, 3.1)) return '5k';
  if (near(mi, 6.2)) return '10k';
  if (near(mi, 13.1)) return 'half';
  if (near(mi, 26.2)) return 'marathon';
  return 'keep_fit';
}

/**
 * Verify a rendered plan against the caps. `distance` is taken explicitly when
 * provided (the renderer/worker know it); otherwise it's inferred from the
 * race distance.
 */
export function validateSafety(
  plan: Plan,
  caps: SafetyCaps,
  distance?: GoalDistance,
): SafetyResult {
  const violations: SafetyViolation[] = [];
  const dist = distance ?? distanceFromMiles(plan.metadata.race.distance_miles);
  const lrCap = caps.maxLongRunMiByDistance[dist];

  const weeks = plan.weeks;
  const phaseOf = (w: Week) => w.phase;
  const longRunMi = (w: Week) =>
    Math.max(
      0,
      ...w.days.filter((d) => d.type === 'long_run').map((d) => d.planned_distance_miles ?? 0),
    );

  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i]!;
    const total = w.planned_total_run_miles ?? 0;
    const lr = longRunMi(w);

    // Long-run absolute cap.
    if (lr > lrCap + EPS) {
      violations.push({
        rule: 'long_run_cap',
        week: w.week_number,
        detail: `long run ${lr} mi exceeds the ${dist} cap of ${lrCap} mi`,
      });
    }

    // Long-run share of the week.
    if (total > 0 && lr > caps.maxLongRunShareOfWeekly * total + EPS) {
      violations.push({
        rule: 'long_run_share',
        week: w.week_number,
        detail: `long run ${lr} mi is ${Math.round((lr / total) * 100)}% of the ${total} mi week (cap ${Math.round(
          caps.maxLongRunShareOfWeekly * 100,
        )}%)`,
      });
    }

    // Hard-day spacing within the week.
    const hardWeekdays = w.days
      .filter((d) => HARD_TYPES.has(d.type))
      .map((d) => WEEKDAYS.indexOf(d.day))
      .filter((x) => x >= 0);
    for (let a = 0; a < hardWeekdays.length; a++) {
      for (let b = a + 1; b < hardWeekdays.length; b++) {
        const d = Math.abs(hardWeekdays[a]! - hardWeekdays[b]!);
        const circ = Math.min(d, 7 - d);
        if (circ < caps.minEasyDaysBetweenHard + 1) {
          violations.push({
            rule: 'hard_day_spacing',
            week: w.week_number,
            detail: `two hard days ${circ} day(s) apart (need ${caps.minEasyDaysBetweenHard + 1})`,
          });
        }
      }
    }

    if (i === 0) continue;
    const prev = weeks[i - 1]!;
    // Ramp + long-run step are build-trend only — exempt cutbacks and the
    // re-ramp out of a cutback.
    if (phaseOf(w) === 'cutback' || phaseOf(prev) === 'cutback') continue;
    if (phaseOf(w) === 'taper' || phaseOf(w) === 'race') continue;
    // An ease-in first week (athlete onboarded mid-week) carries no long run by design, so
    // week 2's first real long run reads as a 0→N jump. That's the start of the
    // progression, not an escalation off a full week — exempt it, like a cutback re-ramp.
    if (i === 1 && phaseOf(prev) !== 'taper' && phaseOf(prev) !== 'race' && longRunMi(prev) === 0) {
      continue;
    }

    const prevTotal = prev.planned_total_run_miles ?? 0;
    const inc = total - prevTotal;
    const allowed = Math.max(prevTotal * caps.maxWeeklyRampPct, caps.minWeeklyRampMi);
    if (inc > allowed + EPS) {
      violations.push({
        rule: 'weekly_ramp',
        week: w.week_number,
        detail: `weekly volume jumped ${round1(inc)} mi (${prevTotal}→${total}); cap is ${round1(allowed)} mi`,
      });
    }

    const prevLr = longRunMi(prev);
    const lrInc = lr - prevLr;
    if (lrInc > caps.maxLongRunStepMi + EPS) {
      violations.push({
        rule: 'long_run_step',
        week: w.week_number,
        detail: `long run jumped ${round1(lrInc)} mi (${prevLr}→${lr}); cap is ${caps.maxLongRunStepMi} mi`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
