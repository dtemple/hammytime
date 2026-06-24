// Side-effect-free coaching run for the model A/B eval (Specs/METERING_PAYMENTS.md
// §14, Specs/EVAL_HARNESS.md Phase 0). Runs the REAL agent — same buildAgentOptions,
// same system prompt, same isolation guard + plan-edit hook as production — but
// stops at the reply. Everything run-agent.ts does AFTER the reply is skipped:
//   - no sendReply / typing / David alerts (Telegram untouched)
//   - no syncBack (memory_files untouched)
//   - no persistPlanEdit / proposal staging (plans untouched)
//   - no persistRun (agent_runs untouched)
//   - no chargeRun / low-balance warn (credits untouched)
//   - no plan-repair second pass
// The plan-edit hook is KEPT (it writes only inside the temp folder) so the run
// behaves like prod; whatever the agent writes lands in a throwaway dir that's
// deleted on the way out.
//
// READ-ONLY against prod data: hydrate reads memory_files + plans + live Strava;
// renderSystemPrompt + loadRecentHistory read DB. None of them write.
//
// Identical-inputs design: hydrateSnapshot() builds the folder + prompts ONCE.
// runSnapshot(snapshot, model) copies that folder into a fresh temp dir and runs
// one model against it, so Haiku and Sonnet see byte-identical files and the same
// prompt — only the model differs (the §14 "same inputs, only the model differs"
// requirement). Each run gets its own dir so the agent's mid-run writes can't
// pollute the other model's run.

import { cp, mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { supabaseAdmin } from '@/lib/db';
import type { Plan } from '@/lib/plan-schema';
import { buildAgentOptions } from './agent-options';
import { cleanup, hash, hydrate } from './folder';
import { sanitizeCoachReply } from './reply-sanitize';
import { buildPrompt, loadRecentHistory, renderSystemPrompt } from './system-prompt';
import type { RunSource } from './run-agent';

const PLAN_FILE = 'marathon_training_plan.json';
const STRAVA_FILE = 'strava_recent.json';

// A one-time hydrate + prompt render. Both models run against a copy of
// sourceDir with this same systemPrompt + prompt — that's what keeps the A/B
// fair. sourceDir is a real hydrated folder kept immutable (we copy, never run
// in it directly); release it with releaseSnapshot when both runs are done.
export type FolderSnapshot = {
  athleteId: string;
  source: RunSource;
  systemPrompt: string;
  prompt: string;
  sourceDir: string;
  planHash?: string;
  plan: Plan | null;
  // Resolved most-recent activity id for a post_activity run (from the folder's
  // strava_recent.json). Undefined when the athlete has no recent Strava.
  activityId?: number;
};

export type DryRunResult = {
  athleteId: string;
  source: RunSource;
  model: string;
  // The reply the athlete would have seen (preamble-stripped, like prod). Empty
  // string if the run errored or produced no text.
  replyText: string;
  resultSubtype: string | null;
  error: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  numTurns: number | null;
  durationMs: number | null;
  // The agent issued a Write/Edit against marathon_training_plan.json this run.
  planEditAttempted: boolean;
  // The plan file's content actually changed vs hydrate (a landed edit). Note:
  // in a dry run this is never persisted — it's diagnostic only.
  planFileChanged: boolean;
  toolUseCount: number;
};

async function loadTimezone(athleteId: string): Promise<string> {
  const { data } = await supabaseAdmin()
    .from('athletes')
    .select('timezone')
    .eq('id', athleteId)
    .maybeSingle();
  return data?.timezone ?? 'America/Los_Angeles';
}

// Reads the most-recent activity id from a hydrated folder's strava_recent.json.
// Picks the max start_date_local rather than trusting array order, so the
// post-activity run reflects the latest workout regardless of how Strava paged
// them. Returns undefined when there are none (no/broken Strava) — the caller
// skips post_activity for that athlete.
async function mostRecentActivityId(folderDir: string): Promise<number | undefined> {
  try {
    const raw = await readFile(path.join(folderDir, STRAVA_FILE), 'utf8');
    const parsed = JSON.parse(raw) as {
      activities?: Array<{ id?: number; start_date_local?: string }>;
    };
    const acts = (parsed.activities ?? []).filter((a) => typeof a.id === 'number');
    if (acts.length === 0) return undefined;
    const latest = acts.reduce((best, a) =>
      (a.start_date_local ?? '') > (best.start_date_local ?? '') ? a : best,
    );
    return latest.id;
  } catch {
    return undefined;
  }
}

/**
 * Hydrate a real athlete folder and render the system + user prompt once. The
 * folder is left on disk as the immutable source the per-model runs copy from.
 * Pass the returned snapshot to runSnapshot for each model, then releaseSnapshot.
 */
export async function hydrateSnapshot(
  athleteId: string,
  source: RunSource,
  opts: { message?: string; activityId?: number } = {},
): Promise<FolderSnapshot> {
  const timezone = await loadTimezone(athleteId);
  const folder = await hydrate(athleteId);

  const activityId =
    source === 'post_activity'
      ? (opts.activityId ?? (await mostRecentActivityId(folder.dir)))
      : opts.activityId;

  const systemPrompt = await renderSystemPrompt(athleteId, folder.plan);
  const history = await loadRecentHistory(athleteId);
  const prompt = buildPrompt(source, timezone, opts.message, history, activityId);

  return {
    athleteId,
    source,
    systemPrompt,
    prompt,
    sourceDir: folder.dir,
    planHash: folder.planHash,
    plan: folder.plan,
    activityId,
  };
}

export async function releaseSnapshot(snapshot: FolderSnapshot): Promise<void> {
  await cleanup(snapshot.sourceDir).catch(() => {});
}

/**
 * Run one model against a copy of the snapshot's folder. Copies the immutable
 * source folder into a fresh temp dir (so the agent's mid-run writes are
 * isolated), runs query() with buildAgentOptions, captures the reply + usage,
 * then deletes the temp dir. No DB, Telegram, or credit side effects.
 */
export async function runSnapshot(snapshot: FolderSnapshot, model: string): Promise<DryRunResult> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ab-eval-'));
  const runDir = path.join(base, 'folder');
  await cp(snapshot.sourceDir, runDir, { recursive: true });

  const options: Options = buildAgentOptions({
    folderDir: runDir,
    systemPrompt: snapshot.systemPrompt,
    model,
  });

  let result: SDKResultMessage | null = null;
  let runError: string | null = null;
  let replyText = '';
  let planEditAttempted = false;
  let toolUseCount = 0;

  try {
    const q = query({ prompt: snapshot.prompt, options });
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const block of contentBlocks(m.message)) {
          if (block?.type === 'tool_use') {
            toolUseCount += 1;
            if (touchesPlanFile(block)) planEditAttempted = true;
          }
        }
        const text = extractAssistantText(m);
        if (text) replyText = text;
      } else if (m.type === 'result') {
        result = m;
      }
    }

    if (result && result.subtype !== 'success') {
      const detail = result.errors?.join('; ');
      runError = `agent run ended with ${result.subtype}${detail ? `: ${detail}` : ''}`;
    } else if (result?.subtype === 'success' && result.result.trim()) {
      replyText = result.result;
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
  }

  // Did a landed edit change the plan file? Compare the post-run file hash to
  // the hydrate-time hash. Diagnostic only — nothing is persisted.
  let planFileChanged = false;
  if (snapshot.planHash) {
    try {
      const after = await readFile(path.join(runDir, PLAN_FILE), 'utf8');
      planFileChanged = hash(after) !== snapshot.planHash;
    } catch {
      planFileChanged = false;
    }
  }

  await rm(base, { recursive: true, force: true }).catch(() => {});

  const usage = result?.usage;
  return {
    athleteId: snapshot.athleteId,
    source: snapshot.source,
    model,
    replyText: runError ? '' : sanitizeCoachReply(replyText).trim(),
    resultSubtype: result?.subtype ?? null,
    error: runError,
    costUsd: result?.total_cost_usd ?? null,
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? null,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? null,
    numTurns: result?.num_turns ?? null,
    durationMs: result?.duration_ms ?? null,
    planEditAttempted,
    planFileChanged,
    toolUseCount,
  };
}

/**
 * Convenience for a standalone single-model dry run (the §14 named signature).
 * Hydrates a fresh folder, runs one model, and tears everything down. The A/B
 * script does NOT use this — it calls hydrateSnapshot once and runSnapshot per
 * model so both models share byte-identical inputs.
 */
export async function dryRunAgent(
  athleteId: string,
  source: RunSource,
  opts: { message?: string; activityId?: number; model: string },
): Promise<DryRunResult> {
  const snapshot = await hydrateSnapshot(athleteId, source, {
    message: opts.message,
    activityId: opts.activityId,
  });
  try {
    return await runSnapshot(snapshot, opts.model);
  } finally {
    await releaseSnapshot(snapshot);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function contentBlocks(message: any): any[] {
  const content = message?.content;
  return Array.isArray(content) ? content : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function touchesPlanFile(block: any): boolean {
  if (block?.name !== 'Write' && block?.name !== 'Edit') return false;
  const fp = block?.input?.file_path;
  return typeof fp === 'string' && path.basename(fp) === PLAN_FILE;
}

function extractAssistantText(m: SDKMessage): string {
  if (m.type !== 'assistant') return '';
  return contentBlocks(m.message)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}
