import { PlanSchema, Plan, DayPlan, PhaseName } from "@/lib/plan-schema";

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
// Helper: day distance for any running day
// ---------------------------------------------------------------------------

function dayDistance(day: DayPlan): number {
  return day.distance_mi ?? 0;
}

function isHardDay(day: DayPlan): boolean {
  if (["hills", "tempo", "track", "race"].includes(day.type)) return true;
  if (day.type === "long_run" && (day.intensity_rpe ?? 0) >= 7) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Rule 1: long_run_cap — long run ≤ 35% of week volume
// ---------------------------------------------------------------------------

function checkLongRunCap(p: Plan): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const week of p.weeks) {
    const days = Object.values(week.days);
    const longRunDays = days.filter((d) => d.type === "long_run");
    const maxLongRun = Math.max(0, ...longRunDays.map(dayDistance));
    const cap = week.planned_volume_mi * 0.35;
    if (maxLongRun > cap + 0.01) {
      errors.push({
        code: "long_run_cap",
        message: `Week ${week.week_number}: long run is ${maxLongRun} mi but the cap is 35% of ${week.planned_volume_mi} mi/week = ${cap.toFixed(1)} mi. Pull back the long run or increase weekly volume.`,
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
  const maxDay = Math.max(0, ...Object.values(week1.days).map(dayDistance));
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
// Rule 3: volume_ramp — ≤10%/week in build phases; one 15% jump per phase tolerated as warning
// ---------------------------------------------------------------------------

function checkVolumeRamp(p: Plan): ValidationError[] {
  const errors: ValidationError[] = [];

  // Group weeks by phase for per-phase 15%-jump tracking
  const phaseJumps: Partial<Record<PhaseName, number>> = {};

  const buildPhases: PhaseName[] = ["base", "build", "peak"];

  for (let i = 1; i < p.weeks.length; i++) {
    const prev = p.weeks[i - 1]!;
    const curr = p.weeks[i]!;

    // Only check consecutive weeks in the same build-type phase
    if (!buildPhases.includes(curr.phase) || curr.phase !== prev.phase) continue;
    if (prev.planned_volume_mi === 0) continue;

    const ramp = (curr.planned_volume_mi - prev.planned_volume_mi) / prev.planned_volume_mi;

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
    const hasRest = Object.values(week.days).some((d) => d.type === "rest");
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
// ---------------------------------------------------------------------------

function checkHardDaySpacing(p: Plan): ValidationError[] {
  // Linearize all days across all weeks
  const dayOrder = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  type DayKey = (typeof dayOrder)[number];

  const linearDays: { week: number; day: string; hard: boolean }[] = [];
  for (const week of p.weeks) {
    for (const key of dayOrder) {
      const d = week.days[key as DayKey];
      linearDays.push({ week: week.week_number, day: key, hard: isHardDay(d) });
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

    // Taper and race weeks are intentionally not cutback weeks — skip them
    if (cutback.phase === "taper" || cutback.phase === "race") continue;

    if (cutback.phase !== "cutback") {
      errors.push({
        code: "cutback_cadence",
        message: `Week ${cutback.week_number} should be a cutback week (every 4th week) but is phase "${cutback.phase}".`,
        location: `week ${cutback.week_number}`,
      });
      continue;
    }

    if (prev.planned_volume_mi === 0) continue;
    const drop = (prev.planned_volume_mi - cutback.planned_volume_mi) / prev.planned_volume_mi;

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
  // Find race week (phase === 'race')
  const raceWeek = p.weeks.find((w) => w.phase === "race");
  if (!raceWeek) return [];

  const raceIdx = p.weeks.indexOf(raceWeek);
  if (raceIdx < 3) return []; // not enough weeks to check

  const taperWeeks = p.weeks.slice(raceIdx - 3, raceIdx);
  if (taperWeeks.length < 3) return [];

  // Peak volume = max over all non-taper, non-race weeks
  const peakVolume = Math.max(
    ...p.weeks
      .filter((w) => w.phase !== "taper" && w.phase !== "race")
      .map((w) => w.planned_volume_mi)
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

    const actual = week.planned_volume_mi / peakVolume;
    if (Math.abs(actual - target) > tolerance + 0.001) {
      errors.push({
        code: "taper_structure",
        message: `Week ${week.week_number} (taper): volume is ${Math.round(actual * 100)}% of peak (${week.planned_volume_mi} mi), expected ~${Math.round(target * 100)}% ±10pp (${Math.round((target - tolerance) * peakVolume)}–${Math.round((target + tolerance) * peakVolume)} mi).`,
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
  const startMs = Date.parse(p.meta.start_date);
  const raceMs = Date.parse(p.meta.goal_race.date);
  if (isNaN(startMs) || isNaN(raceMs)) return [];

  const expectedRaceMs = startMs + p.meta.total_weeks * 7 * 24 * 60 * 60 * 1000;
  const diffDays = Math.abs(expectedRaceMs - raceMs) / (24 * 60 * 60 * 1000);

  if (diffDays > 3) {
    const direction = expectedRaceMs > raceMs ? "after" : "before";
    return [
      {
        code: "timeline_math",
        message: `start_date (${p.meta.start_date}) + ${p.meta.total_weeks} weeks lands ${Math.round(diffDays)} days ${direction} goal race date (${p.meta.goal_race.date}). Adjust start_date or total_weeks so they align within 3 days.`,
        location: "meta",
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rule 9: target_time_consistency — sanity range by distance
// ---------------------------------------------------------------------------

const TIME_SANITY: Array<{ minMi: number; maxMi: number; minSec: number; maxSec: number; label: string }> = [
  { minMi: 13.0, maxMi: 13.5, minSec: 3000, maxSec: 9000, label: "half marathon" },
  { minMi: 26.0, maxMi: 26.5, minSec: 7200, maxSec: 18000, label: "marathon" },
  { minMi: 31.0, maxMi: 31.5, minSec: 10800, maxSec: 25200, label: "50k" },
];

function checkTargetTimeConsistency(p: Plan): ValidationError[] {
  const { target, target_time_sec, distance_mi } = p.meta.goal_race;
  if (target !== "time" || !target_time_sec) return [];

  for (const range of TIME_SANITY) {
    if (distance_mi >= range.minMi && distance_mi <= range.maxMi) {
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
            location: "meta.goal_race.target_time_sec",
          },
        ];
      }
      break;
    }
  }
  return [];
}
