// The shared agent run (M1 plan §3.4). Both job handlers call this.
//
// hydrate folder -> query() with built-in tools confined to that folder ->
// sync changed files back -> send the reply -> record the run. Cleanup always
// runs. Metering of the prepaid balance hooks in here in #12.

import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { supabaseAdmin } from '@/lib/db';
import { COACH_MODEL, MAX_ATTEMPTS, MAX_BUDGET_USD, MAX_TURNS } from './config';
import { isRetryableAgentError } from './retryable';
import { access } from 'fs/promises';
import path from 'path';
import { cleanup, hydrate, syncBack } from './folder';
import { persistPlanEdit } from './plan-version';
import { CANCEL_SENTINEL, discardPendingProposal } from './proposal';
import { makePlanEditHook } from './plan-edit-hook';
import { attemptPlanRepair } from './plan-repair';
import { chargeRun } from './billing';
import { ALLOWED_TOOLS, makeIsolationGuard, scrubbedEnv } from './isolation';
import { persistRun, type CapturedStep, type RunKind } from './persist';
import { stripCoachPreamble } from './reply-sanitize';
import {
  resolveStaleProposalMessage,
  sendCalendarConfirm,
  sendDavidAlert,
  sendReply,
  startTyping,
} from './send';
import {
  buildPrompt,
  loadRecentHistory,
  renderSystemPrompt,
  type PlanExtensionInfo,
} from './system-prompt';

export type RunSource = 'daily_checkin' | 'tg_message' | 'post_activity';

export type RunOpts = {
  // Set by daily-checkin when the plan was auto-extended just before this run
  // (GF-W1) — rides into the system prompt so the coach announces the block.
  planExtension?: PlanExtensionInfo;
  // The job_queue attempt number for this run (1-based; set by the dispatcher).
  // Drives the transient-overload retry: a retryable failure with attempts left
  // throws so the job rides the queue backoff instead of shipping a fallback.
  // Absent (direct callers / tests) → treated as the final attempt, so a run
  // never loops without a queue behind it.
  attempt?: number;
};

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

// Sent on the first attempt when the run failed on a transient Anthropic
// overload (or rate limit / 5xx). The job then rides the queue backoff and
// retries over the next few minutes — this just tells the athlete why their
// answer is late so the silence isn't mistaken for a dropped message.
const OVERLOADED_RETRYING =
  "Anthropic's servers are overloaded right now, so this didn't go through. I'll keep retrying over the next few minutes — nothing for you to do.";

// Sent once the retries are exhausted and the overload still hasn't cleared.
const OVERLOADED_TERMINAL =
  "Anthropic's servers are still overloaded and the retries didn't get through. These spells usually clear quickly — give it about 15 minutes and message me again.";

// Thrown to route a transient failure back through the job_queue backoff
// (worker/index.ts → failJob). The message carries the underlying error so it
// lands in job_queue.last_error.
class RetryableAgentError extends Error {}

// Appended to the coach's reply when a plan edit it described to the athlete
// couldn't be saved (failed validation, then failed a repair pass). Without this
// the athlete is left thinking the change landed while the calendar kept the old
// version. Kept short and plain — no apology spiral.
const PLAN_DROP_NOTICE =
  "One thing — I couldn't get that calendar change to save, so it's still on the previous version for now. I'll fix it and confirm. Nothing for you to do.";

export async function runAgent(
  athleteId: string,
  source: RunSource,
  message?: string,
  activityId?: number,
  opts?: RunOpts,
): Promise<void> {
  const startedAt = new Date().toISOString();
  // Absent attempt (direct callers / tests) → treat as the final attempt: a
  // retryable failure then ships the terminal notice rather than throwing into
  // a queue that isn't there.
  const attempt = opts?.attempt ?? MAX_ATTEMPTS;
  const isFirstAttempt = attempt <= 1;
  const isFinalAttempt = attempt >= MAX_ATTEMPTS;
  const { timezone, name } = await loadAthleteMeta(athleteId);
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
  let planDropped = false;
  // Set when this run staged a plan proposal (Specs/CALENDAR_CONFIRM.md) — the
  // confirm keyboard goes out after the coach's prose, clean runs only.
  let planProposal: { token: string; supersededMessageId?: number } | null = null;
  const steps: CapturedStep[] = [];

  try {
    const systemPrompt = await renderSystemPrompt(athleteId, folder.plan, opts?.planExtension);
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
        // Re-validate marathon_training_plan.json after every Write/Edit so a
        // broken candidate is fixed in-loop, not staged and dropped.
        hooks: makePlanEditHook(folder.dir),
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
      // Fold the API detail (e.g. "API Error: 529 Overloaded") into runError —
      // not just the subtype — so isRetryableAgentError can see it and route a
      // transient overload back through the queue backoff.
      const detail = result.errors?.length ? result.errors.join('; ') : '';
      runError = detail
        ? `agent run ended with ${result.subtype}: ${detail}`
        : `agent run ended with ${result.subtype}`;
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
    // Transient Anthropic overload (or rate limit / 5xx) with attempts left:
    // tell the athlete once (first attempt only), then throw so the job_queue
    // backoff retries instead of dead-ending on a fallback. Skips persist /
    // billing / send below; the finally still cleans up the folder. On the final
    // attempt this branch is skipped and OVERLOADED_TERMINAL goes out instead.
    if (runError && isRetryableAgentError(runError) && !isFinalAttempt) {
      if (isFirstAttempt) {
        await sendReply(athleteId, OVERLOADED_RETRYING).catch((e) =>
          console.error(`[run-agent] overload notice send failed for ${athleteId}:`, e),
        );
      }
      console.warn(
        `[run-agent] athlete ${athleteId} retryable failure (attempt ${attempt}/${MAX_ATTEMPTS}) — throwing for queue retry: ${runError}`,
      );
      throw new RetryableAgentError(runError);
    }

    // Persist file edits on a clean run OR a budget stop — both leave the folder
    // usable. Only a crash/other error skips this (folder may be half-written).
    // persistPlanEdit additionally schema-gates, so a half-written plan is dropped.
    if (!runError || budgetStopped) {
      await syncBack(athleteId, folder).catch((e) =>
        console.error(`[run-agent] syncBack failed for ${athleteId}:`, e),
      );
      // Stage any coach edit to the plan as a proposed candidate — the calendar
      // moves only when the athlete confirms (Specs/CALENDAR_CONFIRM.md).
      let planEdit = await persistPlanEdit(athleteId, folder, timezone).catch((e) => {
        console.error(`[run-agent] persistPlanEdit failed for ${athleteId}:`, e);
        return null;
      });

      // A dropped edit (bad JSON or schema-invalid) usually means one or two
      // fields are malformed — exactly what an LLM fixes in one focused pass. Try
      // a single repair, then re-validate.
      if (
        (planEdit?.outcome === 'dropped_invalid_json' ||
          planEdit?.outcome === 'dropped_schema') &&
        planEdit.detail
      ) {
        console.log(`[run-agent] athlete ${athleteId}: attempting one-shot plan repair`);
        await attemptPlanRepair(folder.dir, planEdit.detail).catch((e) =>
          console.error(`[run-agent] attemptPlanRepair failed for ${athleteId}:`, e),
        );
        planEdit = await persistPlanEdit(athleteId, folder, timezone).catch((e) => {
          console.error(`[run-agent] persistPlanEdit (post-repair) failed for ${athleteId}:`, e);
          return null;
        });
      }

      if (planEdit?.outcome === 'proposed' && planEdit.token) {
        planProposal = {
          token: planEdit.token,
          supersededMessageId: planEdit.supersededMessageId,
        };
      }

      // Agent-initiated cancel: the coach drops a pending proposal by writing
      // CANCEL_SENTINEL into its folder (no plan edit — the working file already
      // matches the active plan). Skipped when this run staged a fresh proposal,
      // which supersedes the pending one anyway.
      if (planEdit?.outcome !== 'proposed') {
        await cancelPendingProposalIfRequested(athleteId, folder.dir);
      }

      // Still dropped after the repair pass. The coach may have told the athlete
      // it changed the plan while the calendar kept the last good version — tell
      // the athlete (PLAN_DROP_NOTICE below) and alert David.
      if (planEdit?.outcome === 'dropped_invalid_json' || planEdit?.outcome === 'dropped_schema') {
        planDropped = true;
        const reason =
          planEdit.outcome === 'dropped_invalid_json' ? 'invalid JSON' : 'failed schema validation';
        const body =
          `Plan edit dropped — kept the last good version (repair pass also failed).\n` +
          `Athlete: ${name} (${athleteId})\n` +
          `Run: ${source}\n` +
          `Reason: ${reason}` +
          (planEdit.detail ? `\n${planEdit.detail}` : '');
        await sendDavidAlert(body).catch((e) =>
          console.error(`[run-agent] David alert failed for ${athleteId}:`, e),
        );
      }
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

    // Draw down the prepaid balance for this run (Specs/METERING_PAYMENTS.md §5):
    // debit cost_usd × markup, idempotent on the run, skipped if comped.
    // Best-effort — a debit failure never blocks delivery. Needs a persisted run
    // to key idempotency on, so skip if persistRun returned null.
    //
    // Successful runs only: a run that errored (final-attempt overload, budget
    // stop, crash) shipped a fallback, not a real answer — the athlete doesn't
    // pay for it even if the failed attempt burned tokens. Earlier retryable
    // attempts threw for a queue retry above, so they were never persisted or
    // charged in the first place.
    if (runId && !runError) {
      await chargeRun(athleteId, runId, result?.total_cost_usd);
    }

    // Any error (incl. a budget stop) sends the fallback — never ship the partial
    // text streamed before the failure as if it were a clean answer.
    // stripCoachPreamble removes a leading "now I'll write…" + `---` artifact the
    // model sometimes prefixes despite the prompt forbidding it (reply-sanitize.ts).
    // If stripping empties the text (model produced only a fenced preamble), the
    // fallback below catches it.
    // A retryable error reaching here is the final attempt (earlier ones threw
    // for a queue retry above) — send the "still overloaded, try in 15" notice
    // rather than the generic snag.
    let finalReply = runError
      ? isRetryableAgentError(runError)
        ? OVERLOADED_TERMINAL
        : SOFT_FALLBACK
      : stripCoachPreamble(replyText).trim() || SOFT_FALLBACK;
    // A plan edit the coach described to the athlete couldn't be saved — append a
    // plain notice so they don't trust a calendar change that didn't land. Only on
    // a clean run: a fallback message never claimed a change in the first place.
    if (planDropped && !runError) {
      finalReply = `${finalReply}\n\n${PLAN_DROP_NOTICE}`;
    }
    await sendReply(athleteId, finalReply, runId ?? undefined);

    // The confirm keyboard (message 2) follows the coach's prose, clean runs
    // only — an errored or budget-stopped run sent the fallback, and "Update
    // your calendar?" must never pair with "hit a snag". Its invisible
    // candidate is superseded by the next clean run or expires on its own.
    // Best-effort: a failed keyboard send must not fail the run — the
    // candidate just expires.
    if (planProposal && !runError) {
      if (planProposal.supersededMessageId !== undefined) {
        await resolveStaleProposalMessage(athleteId, planProposal.supersededMessageId).catch((e) =>
          console.error(`[run-agent] resolveStaleProposalMessage failed for ${athleteId}:`, e),
        );
      }
      await sendCalendarConfirm(athleteId, planProposal.token).catch((e) =>
        console.error(`[run-agent] sendCalendarConfirm failed for ${athleteId}:`, e),
      );
    }
  } finally {
    stopTyping();
    await cleanup(folder.dir).catch((e) =>
      console.error(`[run-agent] cleanup failed for ${athleteId}:`, e),
    );
  }
}

// Drops a pending proposal when the coach wrote CANCEL_SENTINEL this run; a
// no-op when the file is absent. Best-effort — a failure here never breaks the
// run, the proposal just lingers until it expires.
async function cancelPendingProposalIfRequested(
  athleteId: string,
  folderDir: string,
): Promise<void> {
  const requested = await access(path.join(folderDir, CANCEL_SENTINEL))
    .then(() => true)
    .catch(() => false);
  if (!requested) return;

  try {
    const { discarded, staleMessageId } = await discardPendingProposal(athleteId);
    if (discarded && staleMessageId !== undefined) {
      await resolveStaleProposalMessage(
        athleteId,
        staleMessageId,
        'Cancelled — your plan stays as it was.',
      );
    }
  } catch (e) {
    console.error(`[run-agent] cancel pending proposal failed for ${athleteId}:`, e);
  }
}

async function loadAthleteMeta(athleteId: string): Promise<{ timezone: string; name: string }> {
  const { data } = await supabaseAdmin()
    .from('athletes')
    .select('timezone, name')
    .eq('id', athleteId)
    .maybeSingle();
  return {
    timezone: data?.timezone ?? 'America/Los_Angeles',
    name: data?.name ?? athleteId,
  };
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
