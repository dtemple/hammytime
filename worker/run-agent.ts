// The shared agent run (M1 plan §3.4). Both job handlers call this.
//
// hydrate folder -> query() with built-in tools confined to that folder ->
// sync changed files back -> send the reply -> record the run. Cleanup always
// runs. Metering of the prepaid balance hooks in here in #12.

import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { supabaseAdmin } from '@/lib/db';
import { COACH_MODEL, MAX_BUDGET_USD, MAX_TURNS } from './config';
import { cleanup, hydrate, syncBack } from './folder';
import { ALLOWED_TOOLS, makeIsolationGuard, scrubbedEnv } from './isolation';
import { persistRun, type CapturedStep, type RunKind } from './persist';
import { sendReply } from './send';
import { buildPrompt, loadRecentHistory, renderSystemPrompt } from './system-prompt';

export type RunSource = 'daily_checkin' | 'tg_message';

const SOURCE_TO_KIND: Record<RunSource, RunKind> = {
  daily_checkin: 'daily',
  tg_message: 'adhoc',
};

const SOFT_FALLBACK =
  "Hit a snag pulling your coaching together — I'll sort it out and follow up. Nothing on your end to do.";

export async function runAgent(
  athleteId: string,
  source: RunSource,
  message?: string,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const timezone = await loadTimezone(athleteId);
  const folder = await hydrate(athleteId);

  let result: SDKResultMessage | null = null;
  let runError: string | null = null;
  let replyText = '';
  const steps: CapturedStep[] = [];

  try {
    const systemPrompt = await renderSystemPrompt(athleteId);
    const history = await loadRecentHistory(athleteId);
    const prompt = buildPrompt(source, timezone, message, history);

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

    if (result?.subtype === 'success' && result.result.trim()) {
      replyText = result.result;
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    console.error(`[run-agent] athlete ${athleteId} run failed:`, runError);
  }

  try {
    // Only persist the agent's file edits when the run completed cleanly — a
    // crashed run may have left the folder half-written.
    if (!runError) {
      await syncBack(athleteId, folder).catch((e) =>
        console.error(`[run-agent] syncBack failed for ${athleteId}:`, e),
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

    const finalReply = replyText.trim() || SOFT_FALLBACK;
    await sendReply(athleteId, finalReply, runId ?? undefined);
  } finally {
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
