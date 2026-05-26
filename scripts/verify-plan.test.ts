/**
 * verify-plan.test.ts
 *
 * Tests the categorization and output logic for the verify-plan script.
 * We test the underlying PlanSchema + adapter directly rather than shelling
 * out to the script, since the script is just a thin CLI wrapper.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PlanSchema } from "../src/lib/plan-schema";
import { adaptLegacyPlan } from "../src/lib/plan-adapter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadRealPlan() {
  const path = join(process.cwd(), "seeds/marathon_training_plan.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plan verification (schema + adapter)", () => {
  it("real plan fails raw PlanSchema.safeParse — verify script would show errors", () => {
    const raw = loadRealPlan();
    const result = PlanSchema.safeParse(raw);
    // We expect failures because the raw plan doesn't match the hammytime schema.
    expect(result.success).toBe(false);
    expect(result.error!.issues.length).toBeGreaterThan(0);
  });

  it("adapted real plan passes PlanSchema.safeParse — verify script would print success", () => {
    const raw = loadRealPlan();
    const adapted = adaptLegacyPlan(raw, { athleteName: "David Temple" });
    const result = PlanSchema.safeParse(adapted);
    expect(result.success).toBe(true);
  });

  it("known-bad plan fails with identifiable issues", () => {
    const bad = {
      // Missing schema_version, meta, phases — represents a completely wrong shape.
      weeks: [],
    };
    const result = PlanSchema.safeParse(bad);
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join("."));
    // Should flag schema_version and meta at minimum.
    expect(paths).toContain("schema_version");
    expect(paths).toContain("meta");
  });

  it("a plan with an unknown day type is flagged by the schema", () => {
    const raw = loadRealPlan();
    const adapted = adaptLegacyPlan(raw, {});
    // Inject an invalid type into week 1 Monday.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapted.weeks[0].days.mon as any).type = "not_a_real_type";
    const result = PlanSchema.safeParse(adapted);
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join("."));
    expect(paths.some((p) => p.includes("weeks") && p.includes("days"))).toBe(true);
  });
});
