// Records a run to agent_runs + agent_run_steps (M1 plan §9.2).
//
// kind MUST be an allowed value — the agent_runs CHECK constraint permits only
// 'daily' | 'adhoc' | 'weekly' | 'plan_validate'. daily_checkin maps to
// 'daily', tg_message maps to 'adhoc'. (The old code inserted an illegal
// 'daily_checkin' and failed silently — M1 plan §13.)

import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { supabaseAdmin } from '@/lib/db';
import type { Json } from '@/lib/db-types';

export type RunKind = 'daily' | 'adhoc';

export type CapturedStep = {
  kind: 'tool_use' | 'tool_result';
  tool_name?: string;
  input_json?: unknown;
  output_json?: unknown;
};

export type PersistRunArgs = {
  athleteId: string;
  kind: RunKind;
  model: string;
  startedAt: string;
  result: SDKResultMessage | null;
  steps: CapturedStep[];
  error?: string | null;
};

function resultSummary(result: SDKResultMessage | null): string | null {
  if (result && result.subtype === 'success') {
    return result.result.slice(0, 2000);
  }
  return null;
}

function resultError(result: SDKResultMessage | null, error?: string | null): string | null {
  if (error) return error;
  if (result && result.subtype !== 'success') {
    return result.errors?.join('; ') || `agent run ended: ${result.subtype}`;
  }
  return null;
}

export async function persistRun(args: PersistRunArgs): Promise<string | null> {
  const db = supabaseAdmin();
  const usage = args.result?.usage;

  const { data: run, error } = await db
    .from('agent_runs')
    .insert({
      athlete_id: args.athleteId,
      kind: args.kind,
      model: args.model,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? null,
      cost_usd: args.result?.total_cost_usd ?? null,
      result_summary: resultSummary(args.result),
      error: resultError(args.result, args.error),
      started_at: args.startedAt,
      finished_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !run) {
    // Surface, don't throw — recording the run must never block delivery.
    console.error('[persist] agent_runs insert failed:', error?.message);
    return null;
  }

  if (args.steps.length > 0) {
    const rows = args.steps.map((step, i) => ({
      agent_run_id: run.id,
      step_n: i + 1,
      kind: step.kind,
      tool_name: step.tool_name ?? null,
      input_json: (step.input_json ?? null) as Json,
      output_json: (step.output_json ?? null) as Json,
    }));
    const { error: stepErr } = await db.from('agent_run_steps').insert(rows);
    if (stepErr) console.error('[persist] agent_run_steps insert failed:', stepErr.message);
  }

  return run.id;
}
