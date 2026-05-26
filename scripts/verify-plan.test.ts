/**
 * verify-plan.test.ts
 *
 * Tests verify-plan's underlying behavior: raw PlanSchema.safeParse against
 * the canonical plan (no adapter). After the schema refactor the raw parse
 * should always succeed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PlanSchema } from "../src/lib/plan-schema";

function loadRealPlan() {
  const path = join(process.cwd(), "seeds/marathon_training_plan.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("plan verification (raw schema parse)", () => {
  it("real plan passes raw PlanSchema.safeParse — verify script exits 0", () => {
    const raw = loadRealPlan();
    const result = PlanSchema.safeParse(raw);
    if (!result.success) {
      console.error(
        "Unexpected failures:",
        result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
      );
    }
    expect(result.success).toBe(true);
  });

  it("known-bad plan (empty object) fails with identifiable issues", () => {
    const bad = {};
    const result = PlanSchema.safeParse(bad);
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join("."));
    // Should flag metadata and weeks at minimum
    expect(paths.some((p) => p === "metadata" || p.startsWith("metadata"))).toBe(true);
    expect(paths.some((p) => p === "weeks" || p.startsWith("weeks"))).toBe(true);
  });

  it("a plan with an unknown day type is flagged by the schema", () => {
    const raw = loadRealPlan() as { weeks: { days: { type: string }[] }[] };
    raw.weeks[0]!.days[0]!.type = "not_a_real_type";
    const result = PlanSchema.safeParse(raw);
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join("."));
    expect(paths.some((p) => p.includes("weeks") && p.includes("days"))).toBe(true);
  });

  it("a plan with days as object instead of array is rejected", () => {
    const raw = loadRealPlan() as { weeks: { days: unknown }[] };
    raw.weeks[0]!.days = { mon: { type: "easy", description: "Easy." } };
    const result = PlanSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});
