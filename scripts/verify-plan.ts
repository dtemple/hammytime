/**
 * verify-plan.ts
 *
 * Validates a marathon training plan JSON against the hammytime PlanSchema.
 * After the schema refactor, the canonical plan should parse cleanly with no
 * adapter intervention. Exit 0 on clean parse; exit 1 with a grouped issue
 * report on failure.
 *
 * Usage:
 *   npm run plan:verify
 *   MANUAL_PLAN_PATH=/path/to/plan.json npm run plan:verify
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { readFileSync } from 'fs';
import { join } from 'path';
import { ZodIssue } from 'zod';
import { PlanSchema } from '../src/lib/plan-schema';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatIssue(issue: ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  const code = issue.code;
  let detail = '';

  if ('expected' in issue && 'received' in issue) {
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
    process.env.MANUAL_PLAN_PATH ?? join(process.cwd(), 'seeds/marathon_training_plan.json');

  let planJson: unknown;
  try {
    const raw = readFileSync(planPath, 'utf8');
    planJson = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read plan at ${planPath}:`, err);
    process.exit(1);
  }

  console.log(`Verifying: ${planPath}\n`);

  const result = PlanSchema.safeParse(planJson);

  if (result.success) {
    console.log('✓ Plan parses cleanly against current schema. No adapter needed.');
    process.exit(0);
  }

  const issues = result.error.issues;
  console.error(`✗ Plan has ${issues.length} issue(s) against current schema:\n`);
  for (const issue of issues) {
    console.error(formatIssue(issue));
  }

  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
