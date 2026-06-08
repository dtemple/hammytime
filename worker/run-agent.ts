// The shared agent run (M1 plan §3.4). Both job handlers call this.
//
// hydrate folder -> query() with built-in tools confined to that folder ->
// sync changed files back -> send the reply -> record the run. Cleanup always
// runs. Metering of the prepaid balance hooks in here in #12.

import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { supabaseAdmin } from '@/lib/db';
import { COACH_MODEL, MAX_BUDGET_USD, MAX_TURNS } from './config';
import { cleanup, hydrate, syncBack } from './folder';
import { persistPlanEdit } from './plan-version';
import { ALLOWED_TOOLS, makeIsolationGuard, scrubbedEnv } from './isolation';
import { persistRun, type CapturedStep, type RunKind } from './persist';
import { sendReply, startTyping } from './send';
import { buildPrompt, loadRecentHistory, renderSystemPrompt } from './system-prompt';

export type RunSource = 'daily_checkin' | 'tg_message' | 'post_activity';

const SOURCE_TO_KIND: Record<RunSource, RunKind> = {
  daily_checkin: 'daily',
  tg_message: 'adhoc',
  // Reuses 'adhoc' — the agent_runs.kind CHECK only allows daily/adhoc/weekly/
  // plan_validate, so a post-activity run isn't separable in the cost ledger.
  // Splitting it out later is a migration (new kind + CHECK update).
  post_activity: 'adhoc',
};

const SOFT_FALLBACK =
  "Hit a snag pulling your update together — I'll sort it out and follow up. Nothing on your end to do.";

export async function runAgent(
  athleteId: string,
  source: RunSource,
  message?: string,
  activityId?: number,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const timezone = await loadTimezone(athleteId);
  const folder = await hydrate(athleteId);

  // Only for athlete-initiated messages — daily check-ins are proactive, so
  // no one is waiting on a typing indicator. Cleared in the outer finally.
  let stopTyping: () => void = () => {};
  if (source === 'tg_message') {
    stopTyping = await startTyping(athleteId).catch((e) => {
      console.warn('[run-agent] startTyping failed', e);
      return () => {};
    });
  }

  let result: SDKResultMessage | null = null;
  let runError: string | null = null;
  let budgetStopped = false;
  let replyText = '';
  const steps: CapturedStep[] = [];

  try {
    const systemPrompt = await renderSystemPrompt(athleteId, folder.plan);
    const history = await loadRecentHistory(athleteId);
    const prompt = buildPrompt(source, timezone, message, history, activityId);

    const q = query({
      prompt,
      options: {
        model: COACH_MODEL,
        systemPrompt,
        settingSources: [], // hermetic — ignore ~/.claude and any repo .claude
        cwd: folder.dir, // isolation: the agent sees only this athlete's folder
        allowedTools: [...ALLOWED_TOOLS],
        canUseTool: makeIsolationGuard(folder.dir),
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        env: scrubbedEnv(),
      },
    });

    for await (const m of q) {
      captureStep(m, steps);
      if (m.type === 'assistant') {
        const text = extractAssistantText(m);
        if (text) replyText = text;
      } else if (m.type === 'result') {
        result = m;
      }
    }

    if (result && result.subtype !== 'success') {
      // The SDK can return an error result (e.g. an API 429) instead of
      // throwing. Treat it like a thrown failure so we record the error and
      // fall back to SOFT_FALLBACK — never let a raw API error reach Telegram.
      runError = `agent run ended with ${result.subtype}`;
      // A budget stop isn't a crash — the folder holds partial-but-valid work
      // worth keeping. Flag it so persistence below still runs.
      budgetStopped = result.subtype === 'error_max_budget_usd';
      console.error(`[run-agent] athlete ${athleteId} run failed: ${result.subtype}`);
    } else if (result?.subtype === 'success' && result.result.trim()) {
      replyText = result.result;
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    console.error(`[run-agent] athlete ${athleteId} run failed:`, runError);
  }

  try {
    // Persist file edits on a clean run OR a budget stop — both leave the folder
    // usable. Only a crash/other error skips this (folder may be half-written).
    // persistPlanEdit additionally schema-gates, so a half-written plan is dropped.
    if (!runError || budgetStopped) {
      await syncBack(athleteId, folder).catch((e) =>
        console.error(`[run-agent] syncBack failed for ${athleteId}:`, e),
      );
      // Publish any coach edit to the plan as a new working version → calendar.
      await persistPlanEdit(athleteId, folder).catch((e) =>
        console.error(`[run-agent] persistPlanEdit failed for ${athleteId}:`, e),
      );
    }

    const runId = await persistRun({
      athleteId,
      kind: SOURCE_TO_KIND[source],
      model: COACH_MODEL,
      startedAt,
      result,
      steps,
      error: runError,
    });

    // TODO(#12): decrement athlete_credits by result.total_cost_usd * markup.

    // Any error (incl. a budget stop) sends the fallback — never ship the partial
    // text streamed before the failure as if it were a clean answer.
    const finalReply = runError ? SOFT_FALLBACK : replyText.trim() || SOFT_FALLBACK;
    await sendReply(athleteId, finalReply, runId ?? undefined);
  } finally {
    stopTyping();
    await cleanup(folder.dir).catch((e) =>
      console.error(`[run-agent] cleanup failed for ${athleteId}:`, e),
    );
  }
}

async function loadTimezone(athleteId: string): Promise<string> {
  const { data } = await supabaseAdmin()
    .from('athletes')
    .select('timezone')
    .eq('id', athleteId)
    .maybeSingle();
  return data?.timezone ?? 'America/Los_Angeles';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function contentBlocks(message: any): any[] {
  const content = message?.content;
  return Array.isArray(content) ? content : [];
}

function captureStep(m: SDKMessage, steps: CapturedStep[]): void {
  if (m.type === 'assistant') {
    for (const block of contentBlocks(m.message)) {
      if (block?.type === 'tool_use') {
        steps.push({ kind: 'tool_use', tool_name: block.name, input_json: block.input });
      }
    }
  } else if (m.type === 'user') {
    for (const block of contentBlocks(m.message)) {
      if (block?.type === 'tool_result') {
        steps.push({ kind: 'tool_result', output_json: block.content });
      }
    }
  }
}

function extractAssistantText(m: SDKMessage): string {
  if (m.type !== 'assistant') return '';
  return contentBlocks(m.message)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}
