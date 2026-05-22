import { describe, it, expect } from "vitest";
import { PlanSchema, type Plan } from "./plan-schema";

// ---------------------------------------------------------------------------
// Canonical good plan — Annie (18-week, road, finish goal, 4-phase)
// Uses the minimum set of weeks needed to satisfy all refinements.
// Phase coverage: base 1-4, build 5-16 (weeks 5,6,7,8 cutback,9,10,11,12 cutback,13,14,15,16), taper 17-19, race 20
// Keep it small: 4 weeks for a correct-shape plan.
// ---------------------------------------------------------------------------

function makeRestDay() {
  return { type: "rest" as const, description: "Full rest." };
}

function makeEasyDay(mi: number) {
  return { type: "easy" as const, distance_mi: mi, intensity_rpe: 3, description: "Easy run." };
}

function makeLongRunDay(mi: number) {
  return {
    type: "long_run" as const,
    distance_mi: mi,
    intensity_rpe: 5,
    description: "Long easy run.",
  };
}

function makeWeek(
  week_number: number,
  phase: "base" | "build" | "cutback" | "peak" | "taper" | "race",
  volume: number,
  longRun: number
) {
  return {
    week_number,
    phase,
    focus: "Build aerobic base.",
    planned_volume_mi: volume,
    planned_elevation_ft: 500,
    key_notes: "Key week.",
    days: {
      mon: makeLongRunDay(longRun),
      tue: makeEasyDay(volume * 0.15),
      wed: makeRestDay(),
      thu: makeEasyDay(volume * 0.15),
      fri: makeRestDay(),
      sat: makeEasyDay(volume * 0.2),
      sun: makeEasyDay(volume * 0.15),
    },
  };
}

// 4-week plan: base 1-2, build 3, race 4
function goodPlan() {
  return {
    schema_version: 1 as const,
    meta: {
      athlete_name: "Annie",
      goal_race: {
        name: "NYC Marathon",
        date: "2026-11-01",
        distance_mi: 26.2,
        elevation_ft: 800,
        terrain: "road" as const,
        target: "finish" as const,
      },
      start_date: "2026-10-05", // 4 weeks before 2026-11-01 (within ±3d)
      total_weeks: 4,
      weekly_availability: { days_per_week: 5, hours_per_week: 8 },
    },
    phases: [
      { name: "base" as const, start_week: 1, end_week: 2, focus: "Aerobic base." },
      { name: "build" as const, start_week: 3, end_week: 3, focus: "Volume build." },
      { name: "race" as const, start_week: 4, end_week: 4, focus: "Race week." },
    ],
    weeks: [
      makeWeek(1, "base", 20, 6),
      makeWeek(2, "base", 22, 7),
      makeWeek(3, "build", 24, 8),
      makeWeek(4, "race", 5, 1),
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
      pacing_approach: "Even effort throughout.",
      fueling_approach: "Gel every 45 minutes.",
      key_landmarks_to_brief: ["mile 18 climb"],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlanSchema", () => {
  it("accepts a known-good plan", () => {
    const result = PlanSchema.safeParse(goodPlan());
    expect(result.success).toBe(true);
  });

  it("rejects missing schema_version", () => {
    const plan = goodPlan();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (plan as any).schema_version;
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it("rejects schema_version !== 1", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = { ...goodPlan(), schema_version: 2 as any };
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it("rejects target='time' with no target_time_sec (refinement)", () => {
    const plan = goodPlan() as unknown as Plan;
    plan.meta.goal_race = { ...plan.meta.goal_race, target: "time" };
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("target_time_sec");
  });

  it("accepts target='time' with target_time_sec present", () => {
    const plan = goodPlan() as unknown as Plan;
    plan.meta.goal_race = {
      ...plan.meta.goal_race,
      target: "time",
      target_time_sec: 14400,
    };
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("rejects weeks.length !== meta.total_weeks (refinement)", () => {
    const plan = goodPlan();
    plan.meta.total_weeks = 5; // but only 4 weeks in array
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("total_weeks");
  });

  it("rejects a phase gap (week 2 not covered)", () => {
    const plan = goodPlan();
    // Phases cover only weeks 1, 3, 4 — gap at week 2
    plan.phases = [
      { name: "base", start_week: 1, end_week: 1, focus: "Base." },
      { name: "build", start_week: 3, end_week: 3, focus: "Build." },
      { name: "race", start_week: 4, end_week: 4, focus: "Race." },
    ];
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("phases");
  });

  it("rejects phase overlap (week 3 covered twice)", () => {
    const plan = goodPlan();
    plan.phases = [
      { name: "base", start_week: 1, end_week: 3, focus: "Base." },
      { name: "build", start_week: 3, end_week: 4, focus: "Build." },
    ];
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("phases");
  });

  it("rejects invalid day type", () => {
    const plan = goodPlan();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plan.weeks[0]!.days.mon as any).type = "sprint";
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});
