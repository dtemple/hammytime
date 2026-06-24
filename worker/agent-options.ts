// The single source of truth for the coaching agent's query() options.
//
// Both the production run (worker/run-agent.ts) and the model A/B eval harness
// (worker/dry-run-agent.ts → scripts/ab-model-eval.ts) build their options from
// here, so the only thing that can differ between prod and an eval run is the
// model. If these options were assembled inline in run-agent, the eval would
// test a config that drifts from production and its scores would be fiction
// (Specs/EVAL_HARNESS.md "Required refactor").
//
// Behavior-preserving extraction: this returns exactly the object run-agent
// passed inline before. The systemPrompt is rendered by the caller (it depends
// on the athlete's plan + any plan-extension, which are run concerns) and
// passed in — everything else is folder- or config-derived and identical across
// callers.

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { COACH_MODEL, MAX_BUDGET_USD, MAX_TURNS } from './config';
import { ALLOWED_TOOLS, makeIsolationGuard, scrubbedEnv } from './isolation';
import { makePlanEditHook } from './plan-edit-hook';

export type BuildAgentOptionsArgs = {
  // The hydrated athlete folder this run is confined to. cwd, the isolation
  // guard, and the plan-edit hook are all bound to it.
  folderDir: string;
  // The rendered coach system prompt (renderSystemPrompt). Passed in so this
  // module stays free of athlete/plan loading — the part that varies per run.
  systemPrompt: string;
  // Overrides the coach model. Defaults to COACH_MODEL (prod). The A/B harness
  // is the only caller that sets this, to run Haiku against Sonnet.
  model?: string;
};

/**
 * Assembles the query() options for one coaching run. Identical for prod and
 * the eval harness except for `model`. Keep this the only place these options
 * are built.
 */
export function buildAgentOptions({
  folderDir,
  systemPrompt,
  model = COACH_MODEL,
}: BuildAgentOptionsArgs): Options {
  return {
    model,
    systemPrompt,
    settingSources: [], // hermetic — ignore ~/.claude and any repo .claude
    cwd: folderDir, // isolation: the agent sees only this athlete's folder
    allowedTools: [...ALLOWED_TOOLS],
    canUseTool: makeIsolationGuard(folderDir),
    maxTurns: MAX_TURNS,
    maxBudgetUsd: MAX_BUDGET_USD,
    env: scrubbedEnv(),
    // Re-validate marathon_training_plan.json after every Write/Edit so a
    // broken candidate is fixed in-loop, not staged and dropped.
    hooks: makePlanEditHook(folderDir),
  };
}
