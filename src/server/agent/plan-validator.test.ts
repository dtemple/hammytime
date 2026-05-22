import { describe, it, expect } from "vitest";
import { validatePlan } from "./plan-validator";
import type { Plan } from "@/lib/plan-schema";

// ---------------------------------------------------------------------------
// Day helpers
// ---------------------------------------------------------------------------

function restDay() {
  return { type: "rest" as const, description: "Rest." };
}
function easyDay(mi: number) {
  return { type: "easy" as const, distance_mi: mi, intensity_rpe: 3, description: "Easy." };
}
function longDay(mi: number, rpe = 5) {
  return { type: "long_run" as const, distance_mi: mi, intensity_rpe: rpe, description: "Long." };
}
function hillDay(mi: number) {
  return { type: "hills" as const, distance_mi: mi, intensity_rpe: 7, description: "Hills." };
}

type DayOverrides = Partial<Plan["weeks"][0]["days"]>;

function makeDays(overrides: DayOverrides = {}): Plan["weeks"][0]["days"] {
  return {
    mon: longDay(6),
    tue: easyDay(4),
    wed: restDay(),
    thu: easyDay(4),
    fri: restDay(),
    sat: easyDay(4),
    sun: easyDay(2),
    ...overrides,
  };
}

function makeWeek(
  week_number: number,
  phase: Plan["weeks"][0]["phase"],
  volume: number,
  longRun: number,
  daysOverrides: DayOverrides = {}
): Plan["weeks"][0] {
  return {
    week_number,
    phase,
    focus: "Focus.",
    planned_volume_mi: volume,
    planned_elevation_ft: 300,
    key_notes: "",
    days: makeDays({ mon: longDay(longRun), ...daysOverrides }),
  };
}

// ---------------------------------------------------------------------------
// Canonical good plan — 8 weeks, proper structure, all rules pass
//
// Phases: base(1-3), cutback(4), taper(5-7), race(8)
// Peak volume = 24 mi (week 3). Taper: 80/60/40% of 24 = ~20/15/10.
// Start: 2026-09-07 + 8*7=56d = 2026-11-02 ≈ race date 2026-11-01 (±1d ✓)
// Week ramps (same phase):
//   base:  1→2 = 20→22 = +10%, 2→3 = 22→24 = +9.1% — both ≤10% ✓
// Cutback at week 4 (index 3): 18 mi = 25% drop from 24 ✓
// ---------------------------------------------------------------------------

function goodPlan(): Plan {
  return {
    schema_version: 1,
    meta: {
      athlete_name: "Annie",
      goal_race: {
        name: "NYC Marathon",
        date: "2026-11-01",
        distance_mi: 26.2,
        elevation_ft: 800,
        terrain: "road",
        target: "finish",
      },
      start_date: "2026-09-07",
      total_weeks: 8,
      weekly_availability: { days_per_week: 5, hours_per_week: 8 },
    },
    phases: [
      { name: "base", start_week: 1, end_week: 3, focus: "Build base." },
      { name: "cutback", start_week: 4, end_week: 4, focus: "Recovery." },
      { name: "taper", start_week: 5, end_week: 7, focus: "Taper." },
      { name: "race", start_week: 8, end_week: 8, focus: "Race." },
    ],
    weeks: [
      makeWeek(1, "base", 20, 6),    // long 6 = 30% of 20 ✓ (<35%)
      makeWeek(2, "base", 22, 7),    // long 7 = 32% of 22 ✓ | ramp +10% ✓
      makeWeek(3, "base", 24, 8),    // long 8 = 33% of 24 ✓ | ramp +9% ✓
      makeWeek(4, "cutback", 18, 5), // cutback: 25% drop from 24 ✓
      makeWeek(5, "taper", 20, 6),   // 83% of 24 (target 80% ±10pp) ✓
      makeWeek(6, "taper", 15, 5),   // 62% of 24 (target 60% ±10pp) ✓
      makeWeek(7, "taper", 10, 3),   // 42% of 24 (target 40% ±10pp) ✓
      makeWeek(8, "race", 6, 2),     // race week — 2/6 = 33% ✓
    ],
    compliance_rules: {
      hard_day_min_spacing_days: 2,
      max_week_volume_ramp_pct: 10,
      min_rest_days_per_week: 1,
      long_run_cap_pct_of_week: 35,
      cutback_week_frequency: 4,
      cutback_volume_reduction_pct_min: 20,
      cutback_volume_reduction_pct_max: 30,
    },
    race_strategy: {
      pacing_approach: "Even effort.",
      fueling_approach: "Gel every 45 min.",
      key_landmarks_to_brief: [],
    },
  };
}

const ctx = { longest_recent_mi: 10 };

// ---------------------------------------------------------------------------

describe("validatePlan", () => {
  it("passes a correct plan", () => {
    expect(validatePlan(goodPlan(), ctx)).toEqual({ ok: true });
  });

  it("fails schema errors before running rules", () => {
    const result = validatePlan({ schema_version: 2 }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "schema_error")).toBe(true);
    }
  });

  // Rule 1: long_run_cap — long run at 40% of week volume fails
  it("long_run_cap: long run at 40% of volume fails", () => {
    const plan = goodPlan();
    // Week 1: volume 20, make long run 9 = 45%
    plan.weeks[0]!.days.mon = longDay(9);
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
    plan.weeks[0]!.days.mon = longDay(16);
    plan.weeks[0]!.planned_volume_mi = 50; // keep long_run_cap happy
    const result = validatePlan(plan, { longest_recent_mi: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "cold_start_cap")).toBe(true);
    }
  });

  // Rule 3: volume_ramp — >10% jump in same build phase fails
  it("volume_ramp: >15% jump in same build phase fails", () => {
    const plan = goodPlan();
    // Week 2→3 (both base): 22→30 = 36% jump — well above 15% threshold
    plan.weeks[2]!.planned_volume_mi = 30;
    plan.weeks[2]!.days.mon = longDay(9); // keep long_run_cap ok (9/30 = 30%)
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "volume_ramp")).toBe(true);
    }
  });

  // A single 13% jump (between 10% and 15%) is the first jump in the phase → warning, not error
  it("volume_ramp: first 13% jump in a phase does not produce a volume_ramp error", () => {
    const plan = goodPlan();
    // Week 2→3 (both base): 22→24.86 = ~13% — first jump in base phase
    plan.weeks[2]!.planned_volume_mi = 24.9;
    plan.weeks[2]!.days.mon = longDay(8); // 8/24.9 = 32% ✓
    const result = validatePlan(plan, ctx);
    if (!result.ok) {
      // May fail on taper_structure (peak is now higher) but not volume_ramp
      expect(result.errors.some((e) => e.code === "volume_ramp")).toBe(false);
    }
  });

  // Rule 4: rest_days — week with no rest day fails
  it("rest_days: week with no rest day fails", () => {
    const plan = goodPlan();
    plan.weeks[0]!.days.wed = easyDay(4);
    plan.weeks[0]!.days.fri = easyDay(4);
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "rest_days")).toBe(true);
    }
  });

  // Rule 5: hard_day_spacing — 3 hard days in a 7-day window fails
  it("hard_day_spacing: 3 hard days in a 7-day window fails", () => {
    const plan = goodPlan();
    plan.weeks[0]!.days = {
      mon: longDay(6, 7),  // hard: long_run rpe≥7
      tue: easyDay(4),
      wed: restDay(),
      thu: hillDay(5),     // hard: hills
      fri: easyDay(4),
      sat: hillDay(5),     // hard: hills — 3 in one week
      sun: easyDay(2),
    };
    plan.weeks[0]!.planned_volume_mi = 26;
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "hard_day_spacing")).toBe(true);
    }
  });

  // Rule 6: cutback_cadence — week 4 not cutback phase fails
  it("cutback_cadence: week 4 not cutback phase fails", () => {
    const plan = goodPlan();
    plan.weeks[3]!.phase = "build";
    plan.phases[1]!.name = "build";
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
    plan.weeks[4]!.planned_volume_mi = 24; // week 5
    plan.weeks[5]!.planned_volume_mi = 24; // week 6
    plan.weeks[6]!.planned_volume_mi = 24; // week 7
    // Fix long runs to stay under 35% cap
    plan.weeks[4]!.days.mon = longDay(8);
    plan.weeks[5]!.days.mon = longDay(8);
    plan.weeks[6]!.days.mon = longDay(8);
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "taper_structure")).toBe(true);
    }
  });

  // Rule 8: timeline_math — start + weeks lands >3d from race date fails
  it("timeline_math: misaligned start_date fails", () => {
    const plan = goodPlan();
    // Move start 10 days earlier: 2026-08-28 + 8*7=56d = 2026-10-23, race 2026-11-01 = 9d off
    plan.meta.start_date = "2026-08-28";
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "timeline_math")).toBe(true);
    }
  });

  // Rule 9: target_time_consistency — impossible marathon time fails
  it("target_time_consistency: marathon sub-1:00 fails", () => {
    const plan = goodPlan() as unknown as Plan;
    plan.meta.goal_race = {
      ...plan.meta.goal_race,
      target: "time",
      target_time_sec: 3600, // 1:00:00 marathon — impossible
    };
    const result = validatePlan(plan, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "target_time_consistency")).toBe(true);
    }
  });

  it("target_time_consistency: reasonable 4:00 marathon passes consistency check", () => {
    const plan = goodPlan() as unknown as Plan;
    plan.meta.goal_race = {
      ...plan.meta.goal_race,
      target: "time",
      target_time_sec: 14400, // 4:00:00 — reasonable
    };
    const result = validatePlan(plan, ctx);
    if (!result.ok) {
      expect(result.errors.every((e) => e.code !== "target_time_consistency")).toBe(true);
    }
  });
});
