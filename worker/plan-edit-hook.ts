// In-loop validation of coach edits to marathon_training_plan.json (stage 3 of
// Specs/CALENDAR_CONFIRM.md). A PostToolUse hook on Write|Edit re-validates the
// plan file after every edit; a parse or schema failure blocks with the issues
// as tool feedback, so the model fixes the file inside the run instead of
// ending it with a broken candidate. The hook prevents; the drop + repair +
// David-alert backstop in run-agent/plan-version catches anything that still
// lands broken. Both stay.

import { readFile } from 'fs/promises';
import path from 'path';
import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { PlanSchema } from '@/lib/plan-schema';

const PLAN_FILE = 'marathon_training_plan.json';

/**
 * Builds the `hooks` fragment for query() options: validate the plan file
 * after any Write/Edit that touches it. Closes over the athlete folder so
 * relative paths resolve the same way the tools do.
 */
export function makePlanEditHook(
  folderDir: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const planPath = path.resolve(folderDir, PLAN_FILE);

  const validatePlanEdit = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    const toolInput = input.tool_input as { file_path?: unknown } | null;
    const filePath = toolInput?.file_path;
    if (typeof filePath !== 'string') return {};
    if (path.resolve(folderDir, filePath) !== planPath) return {};

    let raw: string;
    try {
      raw = await readFile(planPath, 'utf8');
    } catch {
      return {}; // unreadable right after a Write is the backstop's problem, not the model's
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return block(`it doesn't parse as JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    const result = PlanSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      return block(`it doesn't match the plan schema:\n${issues}`);
    }

    return {};
  };

  return { PostToolUse: [{ matcher: 'Write|Edit', hooks: [validatePlanEdit] }] };
}

function block(why: string): HookJSONOutput {
  return {
    decision: 'block',
    reason:
      `Your edit left ${PLAN_FILE} invalid: ${why}\n` +
      `Fix the file so it parses and matches the schema before finishing.`,
  };
}
