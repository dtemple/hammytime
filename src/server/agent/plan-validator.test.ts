import { describe, it, expect } from "vitest";
import { validatePlan } from "./plan-validator";
import type { Day, Plan, PhaseName } from "@/lib/plan-schema";

// ---------------------------------------------------------------------------
// Day helpers — days array items, Mon → Sun order
// ---------------------------------------------------------------------------

function restDay(dayName: string): Day {
  return { day: dayName, type: "rest", description: "Rest." };
}

function easyDay(dayName: string, mi: number): Day {
  return { day: dayName, type: "easy", planned_distance_miles: mi, description: "Easy." };
}

function longDay(dayName: string, mi: number, opts: { intensity?: string; rpe?: [number, number] } = {}): Day {
  return {
    day: dayName,
    type: "long_run",
    planned_distance_miles: mi,
    ...(opts.intensity ? { intensity: opts.intensity } : {}),
    ...(opts.rpe ? { target_rpe: opts.rpe } : {}),
    description: "Long.",
  };
}

function hardRunDay(dayName: string, mi: number): Day {
  return { day: dayName, type: "hill_repeats", planned_distance_miles: mi, description: "Hills." };
}

// Replace a named day in an array copy (non-mutating).
function setDay(days: Day[], dayName: string, replacement: Day): Day[] {
  return days.map((d) => (d.day === dayName ? replacement : d));
}

// ---------------------------------------------------------------------------
// Week / plan builders
// ---------------------------------------------------------------------------

function makeDays(overrides: Partial<Record<string, Day>> = {}): Day[] {
  const defaults: Day[] = [
    longDay("Monday", 6),
    easyDay("Tuesday", 4),
    restDay("Wednesday"),
    easyDay("Thursday", 4),
    restDay("Friday"),
    easyDay("Saturday", 4),
    easyDay("Sunday", 2),
  ];
  return defaults.map((d) => (overrides[d.day] ? { ...d, ...overrides[d.day] } : d));
}

function makeWeek(
  week_number: number,
  phase: PhaseName,
  volume: number,
  longRun: number,
  dayOverrides: Partial<Record<string, Day>> = {}
): Plan["weeks"][0] {
  return {
    week_number,
    phase,
    planned_total_run_miles: volume,
    days: makeDays({ Monday: longDay("Monday", longRun), ...dayOverrides }),
  };
}

// ---------------------------------------------------------------------------
// Canonical good plan — 8 weeks, all 9 rules pass.
//
// Phases: base(1-3), cutback(4), taper(5-7), race(8)
// Peak = 24 mi (week 3). Taper: ~83/62/42% of 24.
// Start: 2026-09-07 + 56d = 2026-11-02 ≈ race 2026-11-01 (±1d ✓)
// Volume ramps (base): 20→22=+10%, 22→24=+9% — both ≤10% ✓
// Cutback week 4: 18 mi = 25% drop from 24 ✓
// ---------------------------------------------------------------------------

function goodPlan(): Plan {
  return {
    metadata: {
      race: {
        name: "NYC Marathon",
        date: "2026-11-01",
        distance_miles: 26.2,
        elevation_gain_ft: 800,
        type: "road",
        goal: "finish",
      },
      plan_structure: {
        total_weeks: 8,
        start_date: "2026-09-07",
        days_per_week: 5,
        phases: [
          { name: "base", weeks: [1, 2, 3], description: "Build base." },
          { name: "cutback", weeks: [4], description: "Recovery." },
          { name: "taper", weeks: [5, 6, 7], description: "Taper." },
          { name: "race", weeks: [8], description: "Race." },
        ],
      },
    },
    weeks: [
      makeWeek(1, "base", 20, 6),     // long 6 = 30% of 20 ✓ (<35%)
      makeWeek(2, "base", 22, 7),     // long 7 = 32% of 22 ✓ | ramp +10% ✓
      makeWeek(3, "base", 24, 8),     // long 8 = 33% of 24 ✓ | ramp +9% ✓
      makeWeek(4, "cutback", 18, 5),  // cutback: 25% drop from 24 ✓
      makeWeek(5, "taper", 20, 6),    // 83% of 24 (target 80% ±10pp) ✓
      makeWeek(6, "taper", 15, 5),    // 62% of 24 (target 60% ±10pp) ✓
      makeWeek(7, "taper", 10, 3),    // 42% of 24 (target 40% ±10pp) ✓
      makeWeek(8, "race", 6, 2),      // race week
    ],
  };
}

const ctx = { longest_recent_mi: 10 };

// ---------------------------------------------------------------------------

describe("validatePlan", () => {
  it("passes a correct plan", () => {
    expect(validatePlan(goodPlan(), ctx)).toEqual({ ok: true });
  });

  it("fails schema errors before running business-logic rules", () => {
    const result = validatePlan({ metadata: { race: null } }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "schema_error")).toBe(true);
    }
  });

  // Rule 1: long_run_cap — long run at 45% of week volume fails
  it("long_run_cap: long run at 45% of volume fails", () => {
    const plan = goodPlan();
    // Week 1: volume 20, make long run 9 = 45%
    plan.weeks[0]!.days = setDay(plan.weeks[0]!.days, "Monday", longDay("Monday", 9));
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "long_run_cap")).toBe(true);
    }
  });

  // Rule 2: cold_start_cap — week 1 long run > 1.5× longest_recent fails
  it("cold_start_cap: week 1 long run > 1.5x longest_recent fails", () => {
    const plan = goodPlan();
    // longest_recent_mi = 10, cap = 15, set long run to 16
    plan.weeks[0]!.days = setDay(plan.weeks[0]!.days, "Monday", longDay("Monday", 16));
    plan.weeks[0]!.planned_total_run_miles = 50; // keep long_run_cap happy
    const result = validatePlan(plan, { longest_recent_mi: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "cold_start_cap")).toBe(true);
    }
  });

  // Rule 3: volume_ramp — >15% jump in same build phase fails
  it("volume_ramp: >15% jump in same build phase fails", () => {
    const plan = goodPlan();
    // Week 2→3 (both base): 22→30 = 36% jump
    plan.weeks[2]!.planned_total_run_miles = 30;
    plan.weeks[2]!.days = setDay(plan.weeks[2]!.days, "Monday", longDay("Monday", 9)); // 9/30=30% ✓
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "volume_ramp")).toBe(true);
    }
  });

  // A single 13% jump is the first in the phase → warning tolerated, not an error
  it("volume_ramp: first 13% jump in a phase does not produce a volume_ramp error", () => {
    const plan = goodPlan();
    plan.weeks[2]!.planned_total_run_miles = 24.9;
    plan.weeks[2]!.days = setDay(plan.weeks[2]!.days, "Monday", longDay("Monday", 8));
    const result = validatePlan(plan, ctx);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "volume_ramp")).toBe(false);
    }
  });

  // Rule 4: rest_days — week with no rest day fails
  it("rest_days: week with no rest day fails", () => {
    const plan = goodPlan();
    plan.weeks[0]!.days = plan.weeks[0]!.days.map((d) =>
      d.type === "rest" ? easyDay(d.day, 4) : d
    );
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "rest_days")).toBe(true);
    }
  });

  // Rule 5: hard_day_spacing — 3 hard days in a 7-day window fails
  it("hard_day_spacing: 3 hard days in a 7-day window fails", () => {
    const plan = goodPlan();
    plan.weeks[0]!.days = [
      longDay("Monday", 6, { intensity: "hard" }),  // hard: explicit intensity
      easyDay("Tuesday", 4),
      restDay("Wednesday"),
      hardRunDay("Thursday", 5),                    // hard: hill_repeats type
      easyDay("Friday", 4),
      hardRunDay("Saturday", 5),                    // hard: hill_repeats type — 3rd in window
      easyDay("Sunday", 2),
    ];
    plan.weeks[0]!.planned_total_run_miles = 26;
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "hard_day_spacing")).toBe(true);
    }
  });

  // Rule 6: cutback_cadence — week 4 not cutback phase fails
  it("cutback_cadence: week 4 not cutback phase fails", () => {
    const plan = goodPlan();
    // Change week 4's phase label (Zod still passes; business logic fires)
    plan.weeks[3]!.phase = "build";
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "cutback_cadence")).toBe(true);
    }
  });

  // Rule 7: taper_structure — volumes not at 80/60/40% of peak
  it("taper_structure: wrong taper volumes fail", () => {
    const plan = goodPlan();
    // Set all 3 taper weeks to peak volume (24) — completely wrong shape
    plan.weeks[4]!.planned_total_run_miles = 24;
    plan.weeks[5]!.planned_total_run_miles = 24;
    plan.weeks[6]!.planned_total_run_miles = 24;
    // Fix long runs to stay under 35% cap
    plan.weeks[4]!.days = setDay(plan.weeks[4]!.days, "Monday", longDay("Monday", 8));
    plan.weeks[5]!.days = setDay(plan.weeks[5]!.days, "Monday", longDay("Monday", 8));
    plan.weeks[6]!.days = setDay(plan.weeks[6]!.days, "Monday", longDay("Monday", 8));
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "taper_structure")).toBe(true);
    }
  });

  // Rule 8: timeline_math — start + weeks lands >3d from race date fails
  it("timeline_math: misaligned start_date fails", () => {
    const plan = goodPlan();
    // 2026-08-28 + 56d = 2026-10-23, race 2026-11-01 = 9d off
    plan.metadata.plan_structure.start_date = "2026-08-28";
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "timeline_math")).toBe(true);
    }
  });

  // Rule 9: target_time_consistency — impossible marathon time fails
  it("target_time_consistency: marathon sub-1:00 fails", () => {
    const plan = goodPlan();
    plan.metadata.race = {
      ...plan.metadata.race,
      goal: "time",
      target_time_sec: 3600, // 1:00:00 marathon — impossible
    };
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "target_time_consistency")).toBe(true);
    }
  });

  it("target_time_consistency: reasonable 4:00 marathon passes consistency check", () => {
    const plan = goodPlan();
    plan.metadata.race = {
      ...plan.metadata.race,
      goal: "time",
      target_time_sec: 14400, // 4:00:00 — reasonable
    };
    const result = validatePlan(plan, ctx);
    if (!result.ok) {
      expect(result.errors.every((e) => e.code !== "target_time_consistency")).toBe(true);
    }
  });
});
