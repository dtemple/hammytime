// One-shot repair of a coach plan edit that failed schema validation.
//
// When the coach edits marathon_training_plan.json and persistPlanEdit drops it
// (schema-invalid), run-agent calls this once before giving up. It runs a small,
// focused query() against the same athlete folder — Bash denied, the same
// isolation guard as the main run — that reads the file, fixes only the fields
// the validator flagged, and writes it back. run-agent then re-validates; if it
// still fails, the edit is dropped for real and the athlete is told.
//
// This does NOT touch the athlete-facing message. It only repairs the JSON so a
// change the coach already described to the athlete actually lands on the calendar.

import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { COACH_MODEL, PLAN_REPAIR_MAX_BUDGET_USD, PLAN_REPAIR_MAX_TURNS } from './config';
import { ALLOWED_TOOLS, makeIsolationGuard, scrubbedEnv } from './isolation';
import { PLAN_SHAPE_REFERENCE } from '@/lib/plan-shape-reference';

const REPAIR_SYSTEM_PROMPT = `You fix a single JSON file. The file marathon_training_plan.json in your working directory was just edited and failed schema validation. Your only job is to make it valid again, changing as little as possible.

Read the file by its bare filename. Edit only the fields the validation errors point at, and only enough to make them valid — keep every other value, every other day, and the overall structure exactly as they are. Do not restructure the plan, reword descriptions, or "improve" anything. When you're done the file must be valid JSON.

${PLAN_SHAPE_REFERENCE}

You have no one to talk to — there is no athlete on the other end of this run. Don't write a message; just fix the file and stop.`;

/**
 * Runs the focused repair query over the athlete folder. Best-effort: it edits
 * the file in place and returns. The caller re-runs persistPlanEdit to decide
 * whether the repair actually worked — this never throws into run-agent's happy
 * path (callers wrap it in .catch).
 */
export async function attemptPlanRepair(folderDir: string, errorDetail: string): Promise<void> {
  const prompt = `marathon_training_plan.json failed schema validation with these errors (path: message):

${errorDetail}

Read the file, fix exactly these fields, and save it as valid JSON.`;

  let result: SDKResultMessage | null = null;
  const q = query({
    prompt,
    options: {
      model: COACH_MODEL,
      systemPrompt: REPAIR_SYSTEM_PROMPT,
      settingSources: [],
      cwd: folderDir,
      allowedTools: [...ALLOWED_TOOLS],
      canUseTool: makeIsolationGuard(folderDir),
      maxTurns: PLAN_REPAIR_MAX_TURNS,
      maxBudgetUsd: PLAN_REPAIR_MAX_BUDGET_USD,
      env: scrubbedEnv(),
    },
  });

  for await (const m of q) {
    if (m.type === 'result') result = m;
  }

  if (result && result.subtype !== 'success') {
    console.warn(`[plan-repair] repair query ended with ${result.subtype}`);
  }
}
