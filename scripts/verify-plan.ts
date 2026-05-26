/**
 * verify-plan.ts
 *
 * Validates a marathon training plan JSON against the hammytime PlanSchema.
 * Produces a structured discrepancy report on failure — grouped into three
 * categories so you know whether to fix the schema, write an adapter, or
 * inject missing data.
 *
 * Usage:
 *   npm run plan:verify
 *   MANUAL_PLAN_PATH=/path/to/plan.json npm run plan:verify
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "fs";
import { join } from "path";
import { ZodIssue } from "zod";
import { PlanSchema } from "../src/lib/plan-schema";
import { adaptLegacyPlan } from "../src/lib/plan-adapter";

// ---------------------------------------------------------------------------
// Categorization — hardcoded judgment calls based on the known diff between
// the health-agent plan shape and the hammytime schema.
// ---------------------------------------------------------------------------

type IssueCategory =
  | "Schema bug"
  | "Naming mismatch"
  | "Plan structure missing";

function categorize(issue: ZodIssue): IssueCategory {
  const path = issue.path.map(String).join(".");

  // Schema bugs: wrong type, missing enum value, structural mismatch we own
  const schemaBugPatterns = [
    /^weeks\.\d+\.days$/,             // days should be array, schema has object
    /^weeks\.\d+\.days\.\d+\.type$/,  // enum missing real-plan day types
    /^weeks\.\d+\.days\.\d+\.target_rpe/, // schema doesn't know target_rpe
    /^weeks\.\d+\.days\.\d+\.intensity_rpe/, // schema requires number, plan has array
    /^schema_version$/,               // schema expects literal 1, plan has none
  ];

  if (schemaBugPatterns.some((re) => re.test(path))) {
    return "Schema bug";
  }

  // Naming mismatches: same data, different field name / location
  const namingMismatchPatterns = [
    /^plan_version$/,
    /^metadata/,
    /^weeks\.\d+\.planned_total_run_miles/,
    /^weeks\.\d+\.coaching_note/,
    /^weeks\.\d+\.days\.\d+\.planned_distance_miles/,
    /^weeks\.\d+\.start_date/,
    /^weeks\.\d+\.end_date/,
    /^phases/,
    /^agent_guidance/,
    /^strength_workouts/,
  ];

  if (namingMismatchPatterns.some((re) => re.test(path))) {
    return "Naming mismatch";
  }

  // Everything else: plan is genuinely missing something the schema requires
  return "Plan structure missing";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatIssue(issue: ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  const code = issue.code;
  let detail = "";

  if ("expected" in issue && "received" in issue) {
    detail = ` (expected ${String(issue.expected)}, got ${String(issue.received)})`;
  } else if (issue.message) {
    detail = ` — ${issue.message}`;
  }

  return `  • ${path} [${code}]${detail}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const planPath =
    process.env.MANUAL_PLAN_PATH ??
    join(process.cwd(), "seeds/marathon_training_plan.json");

  let planJson: unknown;
  try {
    const raw = readFileSync(planPath, "utf8");
    planJson = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read plan at ${planPath}:`, err);
    process.exit(1);
  }

  console.log(`Verifying: ${planPath}\n`);

  // First: try raw (no adapter needed if this passes).
  const rawResult = PlanSchema.safeParse(planJson);

  if (rawResult.success) {
    console.log("✓ Plan parses cleanly against current schema. No adapter needed.");
    process.exit(0);
  }

  // Second: try with adapter. This tells us whether the adapter resolves all issues.
  try {
    const adapted = adaptLegacyPlan(planJson);
    const adaptedResult = PlanSchema.safeParse(adapted);
    if (adaptedResult.success) {
      console.log(
        "✓ Plan parses cleanly after adaptation (src/lib/plan-adapter.ts).\n" +
        "  The raw plan has discrepancies below, but the adapter resolves all of them.\n"
      );
    } else {
      console.error(
        `✗ Even after adaptation, ${adaptedResult.error.issues.length} issue(s) remain — ` +
        "adapter may need updating.\n"
      );
    }
  } catch (adapterErr) {
    console.error("✗ Adapter threw during adaptation:", adapterErr, "\n");
  }

  const issues = rawResult.error.issues;
  console.error(`Raw plan has ${issues.length} issue(s) against current schema:\n`);

  const grouped: Record<IssueCategory, ZodIssue[]> = {
    "Schema bug": [],
    "Naming mismatch": [],
    "Plan structure missing": [],
  };

  for (const issue of issues) {
    grouped[categorize(issue)].push(issue);
  }

  const categoryOrder: IssueCategory[] = [
    "Schema bug",
    "Naming mismatch",
    "Plan structure missing",
  ];

  const descriptions: Record<IssueCategory, string> = {
    "Schema bug": "Schema bug — the schema is wrong; fix it to match the canonical plan.",
    "Naming mismatch": "Naming mismatch — same data, different field name; write an adapter or rename in schema.",
    "Plan structure missing": "Plan structure missing — the plan genuinely lacks data the schema requires; relax the schema or inject defaults.",
  };

  for (const cat of categoryOrder) {
    const items = grouped[cat];
    if (items.length === 0) continue;
    console.error(`── ${descriptions[cat]} (${items.length})\n`);
    for (const issue of items) {
      console.error(formatIssue(issue));
    }
    console.error("");
  }

  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
