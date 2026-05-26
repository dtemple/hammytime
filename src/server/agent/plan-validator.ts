import { PlanSchema, Plan, Day, PhaseName } from "@/lib/plan-schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AthleteValidationContext = {
  longest_recent_mi: number;
};

export type ValidationError = {
  code: string;
  message: string;
  location?: string;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function validatePlan(
  plan: unknown,
  ctx: AthleteValidationContext
): ValidationResult {
  const parsed = PlanSchema.safeParse(plan);

  if (!parsed.success) {
    const errors: ValidationError[] = parsed.error.issues.map((issue) => {
      const readablePath = issue.path.filter(
        (p): p is string | number => typeof p !== "symbol"
      );
      return {
        code: "schema_error",
        message: humanizeZodMessage(issue),
        location: readablePath.length > 0 ? readablePath.join(".") : undefined,
      };
    });
    return { ok: false, errors };
  }

  const p = parsed.data;
  const errors: ValidationError[] = [
    ...checkLongRunCap(p),
    ...checkColdStartCap(p, ctx),
    ...checkVolumeRamp(p),
    ...checkRestDays(p),
    ...checkHardDaySpacing(p),
    ...checkCutbackCadence(p),
    ...checkTaperStructure(p),
    ...checkTimelineMath(p),
    ...checkTargetTimeConsistency(p),
  ];

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Zod → human message translation
// ---------------------------------------------------------------------------

function humanizeZodMessage(issue: { message: string; path: PropertyKey[] }): string {
  const readablePath = issue.path.filter((p): p is string | number => typeof p !== "symbol");
  const loc = readablePath.length > 0 ? ` (at ${readablePath.join(".")})` : "";
  return `${issue.message}${loc}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dayDistance(day: Day): number {
  return day.planned_distance_miles ?? 0;
}

function weekVolume(week: Plan["weeks"][0]): number {
  return week.planned_total_run_miles ?? 0;
}

function isHardDay(day: Day): boolean {
  // Type-based: these are always high-intensity
  if (["hill_repeats", "trail_tempo", "race"].includes(day.type)) return true;
  // Intensity string: explicitly flagged hard
  if (day.intensity === "hard") return true;
  // RPE upper bound ≥ 7
  if (Array.isArray(day.target_rpe) && day.target_rpe[1] >= 7) return true;
  // Long run with high RPE
  if (day.type === "long_run" && Array.isArray(day.target_rpe) && day.target_rpe[0] >= 7) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Rule 1: long_run_cap — long run ≤ 35% of week volume
// ---------------------------------------------------------------------------

function checkLongRunCap(p: Plan): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const week of p.weeks) {
    const longRunDays = week.days.filter((d) => d.type === "long_run");
    const maxLongRun = Math.max(0, ...longRunDays.map(dayDistance));
    const vol = weekVolume(week);
    if (vol === 0) continue;
    const cap = vol * 0.35;
    if (maxLongRun > cap + 0.01) {
      errors.push({
        code: "long_run_cap",
        message: `Week ${week.week_number}: long run is ${maxLongRun} mi but the cap is 35% of ${vol} mi/week = ${cap.toFixed(1)} mi. Pull back the long run or increase weekly volume.`,
        location: `week ${week.week_number}`,
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Rule 2: cold_start_cap — week 1 max day distance ≤ 1.5× longest_recent_mi
// ---------------------------------------------------------------------------

function checkColdStartCap(p: Plan, ctx: AthleteValidationContext): ValidationError[] {
  const week1 = p.weeks.find((w) => w.week_number === 1);
  if (!week1) return [];
  const maxDay = Math.max(0, ...week1.days.map(dayDistance));
  const cap = ctx.longest_recent_mi * 1.5;
  if (maxDay > cap + 0.01) {
    return [
      {
        code: "cold_start_cap",
        message: `Week 1: longest day is ${maxDay} mi but your cold-start cap is 1.5× ${ctx.longest_recent_mi} mi = ${cap.toFixed(1)} mi. Week 1 is jumping ahead of your current fitness.`,
        location: "week 1",
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rule 3: volume_ramp — ≤10%/week in build phases; one 15% jump per phase tolerated
// ---------------------------------------------------------------------------

function checkVolumeRamp(p: Plan): ValidationError[] {
  const errors: ValidationError[] = [];
  const phaseJumps: Partial<Record<PhaseName, number>> = {};
  const buildPhases: PhaseName[] = ["base", "build", "peak"];

  for (let i = 1; i < p.weeks.length; i++) {
    const prev = p.weeks[i - 1]!;
    const curr = p.weeks[i]!;

    if (!buildPhases.includes(curr.phase) || curr.phase !== prev.phase) continue;
    const prevVol = weekVolume(prev);
    const currVol = weekVolume(curr);
    if (prevVol === 0) continue;

    const ramp = (currVol - prevVol) / prevVol;

    if (ramp > 0.15 + 0.001) {
      errors.push({
        code: "volume_ramp",
        message: `Week ${curr.week_number}: volume jumps ${Math.round(ramp * 100)}% over week ${prev.week_number}. Max is 10% (one 15% jump per phase is tolerated as a warning).`,
        location: `week ${curr.week_number}`,
      });
    } else if (ramp > 0.10 + 0.001) {
      const phase = curr.phase;
      phaseJumps[phase] = (phaseJumps[phase] ?? 0) + 1;
      if ((phaseJumps[phase] ?? 0) > 1) {
        errors.push({
          code: "volume_ramp",
          message: `Week ${curr.week_number}: second 15% volume jump in the ${phase} phase. Only one per phase is allowed.`,
          location: `week ${curr.week_number}`,
        });
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Rule 4: rest_days — ≥1 rest day per week
// ---------------------------------------------------------------------------

function checkRestDays(p: Plan): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const week of p.weeks) {
    const hasRest = week.days.some((d) => d.type === "rest");
    if (!hasRest) {
      errors.push({
        code: "rest_days",
        message: `Week ${week.week_number} has no rest day. Every week needs at least one full rest day.`,
        location: `week ${week.week_number}`,
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Rule 5: hard_day_spacing — ≤2 hard days per any rolling 7-day window
// Days are iterated in the order they appear in each week's days array
// (canonical plan orders Mon → Sun).
// ---------------------------------------------------------------------------

function checkHardDaySpacing(p: Plan): ValidationError[] {
  const linearDays: { week: number; day: string; hard: boolean }[] = [];
  for (const week of p.weeks) {
    for (const d of week.days) {
      linearDays.push({ week: week.week_number, day: d.day, hard: isHardDay(d) });
    }
  }

  const errors: ValidationError[] = [];
  const reported = new Set<number>();

  for (let i = 0; i <= linearDays.length - 7; i++) {
    const window = linearDays.slice(i, i + 7);
    const hardCount = window.filter((d) => d.hard).length;
    if (hardCount > 2) {
      const start = window[0]!;
      const key = i;
      if (!reported.has(key)) {
        reported.add(key);
        errors.push({
          code: "hard_day_spacing",
          message: `${hardCount} hard days in the 7-day window starting week ${start.week} (${start.day}). Maximum is 2.`,
          location: `week ${start.week}, ${start.day}`,
        });
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Rule 6: cutback_cadence — every 4th week is cutback, 20–30% volume drop
// ---------------------------------------------------------------------------

function checkCutbackCadence(p: Plan): ValidationError[] {
  const errors: ValidationError[] = [];

  for (let i = 3; i < p.weeks.length; i += 4) {
    const cutback = p.weeks[i]!;
    const prev = p.weeks[i - 1]!;

    if (cutback.phase === "taper" || cutback.phase === "race") continue;

    if (cutback.phase !== "cutback") {
      errors.push({
        code: "cutback_cadence",
        message: `Week ${cutback.week_number} should be a cutback week (every 4th week) but is phase "${cutback.phase}".`,
        location: `week ${cutback.week_number}`,
      });
      continue;
    }

    const prevVol = weekVolume(prev);
    if (prevVol === 0) continue;
    const cutbackVol = weekVolume(cutback);
    const drop = (prevVol - cutbackVol) / prevVol;

    if (drop < 0.20 - 0.001) {
      errors.push({
        code: "cutback_cadence",
        message: `Week ${cutback.week_number} (cutback): volume drops only ${Math.round(drop * 100)}% from week ${prev.week_number}. Cutbacks need a 20–30% drop.`,
        location: `week ${cutback.week_number}`,
      });
    } else if (drop > 0.30 + 0.001) {
      errors.push({
        code: "cutback_cadence",
        message: `Week ${cutback.week_number} (cutback): volume drops ${Math.round(drop * 100)}% from week ${prev.week_number}. That's more than the 30% max — recovery risk.`,
        location: `week ${cutback.week_number}`,
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Rule 7: taper_structure — last 3 weeks before race week at ~80/60/40% of peak
// ---------------------------------------------------------------------------

function checkTaperStructure(p: Plan): ValidationError[] {
  const raceWeek = p.weeks.find((w) => w.phase === "race");
  if (!raceWeek) return [];

  const raceIdx = p.weeks.indexOf(raceWeek);
  if (raceIdx < 3) return [];

  const taperWeeks = p.weeks.slice(raceIdx - 3, raceIdx);
  if (taperWeeks.length < 3) return [];

  const peakVolume = Math.max(
    ...p.weeks
      .filter((w) => w.phase !== "taper" && w.phase !== "race")
      .map(weekVolume)
  );
  if (peakVolume === 0) return [];

  const targets = [0.80, 0.60, 0.40];
  const tolerance = 0.10;
  const errors: ValidationError[] = [];

  taperWeeks.forEach((week, i) => {
    const target = targets[i]!;

    if (week.phase !== "taper") {
      errors.push({
        code: "taper_structure",
        message: `Week ${week.week_number} should be phase "taper" (${Math.round(target * 100)}% of peak) but is "${week.phase}".`,
        location: `week ${week.week_number}`,
      });
      return;
    }

    const actual = weekVolume(week) / peakVolume;
    if (Math.abs(actual - target) > tolerance + 0.001) {
      errors.push({
        code: "taper_structure",
        message: `Week ${week.week_number} (taper): volume is ${Math.round(actual * 100)}% of peak (${weekVolume(week)} mi), expected ~${Math.round(target * 100)}% ±10pp (${Math.round((target - tolerance) * peakVolume)}–${Math.round((target + tolerance) * peakVolume)} mi).`,
        location: `week ${week.week_number}`,
      });
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Rule 8: timeline_math — start_date + total_weeks*7d ≈ goal_race.date ±3d
// ---------------------------------------------------------------------------

function checkTimelineMath(p: Plan): ValidationError[] {
  const startMs = Date.parse(p.metadata.plan_structure.start_date);
  const raceMs = Date.parse(p.metadata.race.date);
  if (isNaN(startMs) || isNaN(raceMs)) return [];

  const totalWeeks = p.metadata.plan_structure.total_weeks;
  const expectedRaceMs = startMs + totalWeeks * 7 * 24 * 60 * 60 * 1000;
  const diffDays = Math.abs(expectedRaceMs - raceMs) / (24 * 60 * 60 * 1000);

  if (diffDays > 3) {
    const direction = expectedRaceMs > raceMs ? "after" : "before";
    return [
      {
        code: "timeline_math",
        message: `start_date (${p.metadata.plan_structure.start_date}) + ${totalWeeks} weeks lands ${Math.round(diffDays)} days ${direction} goal race date (${p.metadata.race.date}). Adjust start_date or total_weeks so they align within 3 days.`,
        location: "metadata.plan_structure",
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rule 9: target_time_consistency — sanity range by distance
// ---------------------------------------------------------------------------

const TIME_SANITY: Array<{
  minMi: number;
  maxMi: number;
  minSec: number;
  maxSec: number;
  label: string;
}> = [
  { minMi: 13.0, maxMi: 13.5, minSec: 3000, maxSec: 9000, label: "half marathon" },
  { minMi: 26.0, maxMi: 26.5, minSec: 7200, maxSec: 18000, label: "marathon" },
  { minMi: 31.0, maxMi: 31.5, minSec: 10800, maxSec: 25200, label: "50k" },
];

function checkTargetTimeConsistency(p: Plan): ValidationError[] {
  const { goal, target_time_sec, distance_miles } = p.metadata.race;
  if (goal !== "time" || !target_time_sec) return [];

  for (const range of TIME_SANITY) {
    if (distance_miles >= range.minMi && distance_miles <= range.maxMi) {
      if (target_time_sec < range.minSec || target_time_sec > range.maxSec) {
        const fmtSec = (s: number) => {
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          return `${h}:${String(m).padStart(2, "0")}`;
        };
        return [
          {
            code: "target_time_consistency",
            message: `target_time_sec ${target_time_sec}s (${fmtSec(target_time_sec)}) is outside the sanity range for a ${range.label} (${fmtSec(range.minSec)}–${fmtSec(range.maxSec)}). Please double-check the goal time.`,
            location: "metadata.race.target_time_sec",
          },
        ];
      }
      break;
    }
  }
  return [];
}
