import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { adaptLegacyPlan } from "./plan-adapter";
import { PlanSchema } from "./plan-schema";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function loadRealPlan() {
  const path = join(process.cwd(), "seeds/marathon_training_plan.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function makeCanonicalPlan() {
  // A minimal schema_version: 1 plan (same shape as plan-schema.test.ts).
  return {
    schema_version: 1 as const,
    meta: {
      athlete_name: "Test Athlete",
      goal_race: {
        name: "Test Marathon",
        date: "2026-11-01",
        distance_mi: 26.2,
        elevation_ft: 100,
        terrain: "road" as const,
        target: "finish" as const,
      },
      start_date: "2026-10-05",
      total_weeks: 2,
      weekly_availability: { days_per_week: 5 },
    },
    phases: [
      { name: "base" as const, start_week: 1, end_week: 1 },
      { name: "race" as const, start_week: 2, end_week: 2 },
    ],
    weeks: [
      makeWeek(1, "base"),
      makeWeek(2, "race"),
    ],
  };
}

function makeWeek(n: number, phase: "base" | "race") {
  const rest = { type: "rest" as const, description: "Rest." };
  const easy = { type: "easy" as const, distance_mi: 3, description: "Easy." };
  return {
    week_number: n,
    phase,
    planned_volume_mi: 10,
    key_notes: "notes",
    days: { mon: easy, tue: rest, wed: easy, thu: rest, fri: easy, sat: rest, sun: rest },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("adaptLegacyPlan", () => {
  describe("canonical passthrough", () => {
    it("returns a valid Plan when input already has schema_version: 1", () => {
      const canonical = makeCanonicalPlan();
      const plan = adaptLegacyPlan(canonical);
      expect(plan.schema_version).toBe(1);
      expect(plan.meta.goal_race.name).toBe("Test Marathon");
    });

    it("canonical plan validates against PlanSchema without errors", () => {
      const plan = adaptLegacyPlan(makeCanonicalPlan());
      const result = PlanSchema.safeParse(plan);
      expect(result.success).toBe(true);
    });
  });

  describe("health-agent format transform", () => {
    it("transforms the real marathon_training_plan.json without throwing", () => {
      const raw = loadRealPlan();
      expect(() => adaptLegacyPlan(raw, { athleteName: "David Temple" })).not.toThrow();
    });

    it("produces a plan that validates against PlanSchema", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, { athleteName: "David Temple" });
      const result = PlanSchema.safeParse(plan);
      expect(result.success).toBe(true);
    });

    it("maps meta.goal_race fields correctly", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, { athleteName: "David" });
      expect(plan.meta.goal_race.name).toBe("Trail Marathon");
      expect(plan.meta.goal_race.distance_mi).toBe(26.2);
      expect(plan.meta.goal_race.terrain).toBe("trail");
      expect(plan.meta.goal_race.target).toBe("finish");
      expect(plan.meta.goal_race.date).toBe("2026-08-30");
    });

    it("maps meta top-level fields correctly", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, { athleteName: "David" });
      expect(plan.meta.total_weeks).toBe(22);
      expect(plan.meta.start_date).toBe("2026-03-30");
      expect(plan.meta.athlete_name).toBe("David");
      expect(plan.meta.weekly_availability.days_per_week).toBe(6);
    });

    it("converts week 1 days array to named-key object", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, {});
      const days = plan.weeks[0].days;
      // Week 1: Monday = long_run, Sunday = rest
      expect(days.mon.type).toBe("long_run");
      expect(days.sun.type).toBe("rest");
    });

    it("maps planned_total_run_miles to planned_volume_mi", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, {});
      expect(plan.weeks[0].planned_volume_mi).toBe(16);
    });

    it("maps coaching_note to key_notes", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, {});
      expect(plan.weeks[0].key_notes).toBe("Settle into new schedule; all easy effort");
    });

    it("decomposes non-contiguous phase weeks into contiguous runs", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, {});
      // cutback phases are [4, 8, 12, 16] → 4 single-week entries
      const cutbacks = plan.phases.filter((p) => p.name === "cutback");
      expect(cutbacks.length).toBe(4);
      cutbacks.forEach((p) => expect(p.start_week).toBe(p.end_week));
    });

    it("phase coverage refinement passes for the full 22-week plan", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, {});
      // Verify all 22 weeks are covered exactly once
      const covered = new Array(23).fill(0);
      for (const p of plan.phases) {
        for (let w = p.start_week; w <= p.end_week; w++) covered[w]++;
      }
      for (let w = 1; w <= 22; w++) {
        expect(covered[w]).toBe(1);
      }
    });

    it("preserves agent_guidance on the plan", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, {});
      expect(plan.agent_guidance).toBeDefined();
    });

    it("preserves strength_workouts on the plan", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, {});
      expect(plan.strength_workouts).toBeDefined();
    });

    it("does not set distance_mi for rest-day 0-distance entries", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, {});
      // Week 22 Thursday is a rest day with planned_distance_miles: 0
      expect(plan.weeks[21].days.thu.distance_mi).toBeUndefined();
    });

    it("injects race_strategy SHIM when absent from source", () => {
      const raw = loadRealPlan();
      const plan = adaptLegacyPlan(raw, {});
      expect(plan.race_strategy).toBeDefined();
      expect(Array.isArray(plan.race_strategy!.key_landmarks_to_brief)).toBe(true);
    });
  });

  describe("error cases", () => {
    it("throws on null input", () => {
      expect(() => adaptLegacyPlan(null)).toThrow("not an object");
    });

    it("throws on unrecognized format (no schema_version or plan_version)", () => {
      expect(() => adaptLegacyPlan({ foo: "bar" })).toThrow(
        "Unrecognized plan format"
      );
    });

    it("throws a Zod error when canonical plan fails validation", () => {
      const bad = { schema_version: 1 as const, meta: null, phases: [], weeks: [] };
      expect(() => adaptLegacyPlan(bad)).toThrow();
    });
  });
});
