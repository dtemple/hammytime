import { InlineKeyboard } from 'grammy';
import type { Plan } from '@/lib/plan-schema';
import type { GoalDistance, RenderParams } from '@/lib/plan-templates';
import { enqueueJob } from '@/server/jobs/enqueue';
import { sendDavidAlert } from '@/server/admin/alerts';
import {
  generateAndPersistPlan,
  getActiveTemplatePlan,
  setPlanStrengthToZero,
} from '../plan-gen';
import type { OnboardingStep, StepHandleResult } from '../types';

// Beat B1 (onboarding v2, W4): the payoff. The deterministic template engine
// renders a plan from everything collected so far, we persist it as the athlete's
// baseline + initial working version, and show it back with [Looks good] /
// [Adjust it]. "Payoff before enrichment" — this is the first time the athlete
// sees a real plan, which is why it sits before the optional enrichment dump.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const DISTANCE_LABEL: Record<GoalDistance, string> = {
  '5k': 'a 5K',
  '10k': 'a 10K',
  half: 'a half marathon',
  marathon: 'a marathon',
  keep_fit: 'general fitness',
};

function previewKeyboard(params: RenderParams): InlineKeyboard {
  const kb = new InlineKeyboard().text('Looks good', 'plan:good').text('Adjust it', 'plan:adjust');
  if (params.strengthSessionsPerWeek > 0) {
    kb.row().text('Skip strength', 'plan:nostrength');
  }
  return kb;
}

function peakLongRunMi(plan: Plan): number {
  let peak = 0;
  for (const week of plan.weeks) {
    for (const day of week.days) {
      if (day.type === 'long_run' && (day.planned_distance_miles ?? 0) > peak) {
        peak = day.planned_distance_miles ?? 0;
      }
    }
  }
  return Math.round(peak);
}

// The B1 preview copy. Two variants: a committed-race countdown (dated, with a
// peak), and an open-ended base+build block (no race locked → no taper yet).
export function formatPreview(plan: Plan, params: RenderParams): string {
  const ps = plan.metadata.plan_structure;
  const lrDay = ps.long_run_day ?? DAY_NAMES[params.longRunDay] ?? 'your usual long-run day';
  const vol = plan.metadata.athlete?.baseline_weekly_miles;
  const startMi = Math.round(vol?.min ?? params.startVolumeMi);
  const peakMi = Math.round(vol?.max ?? params.peakVolumeMi);
  const peakLong = peakLongRunMi(plan);

  const lines: string[] = [];

  if (params.race) {
    lines.push(
      `Here's your starting plan: **${ps.total_weeks} weeks to ${params.race.name}, ` +
        `building from ~${startMi} to ~${peakMi} mi/wk, long runs on ${lrDay}, peaking at ${peakLong}.**`,
    );
    lines.push(
      "No time goal locked in yet, so I've set everything by feel — we can dial in paces once " +
        "you've got a target. It's a starting point, not a contract; we'll adjust as we go.",
    );
  } else if (params.distance === 'keep_fit') {
    lines.push(
      `Here's your starting plan: **a rolling base to keep you fit, growing from ~${startMi} to ` +
        `~${peakMi} mi/wk, long runs on ${lrDay}.** No fixed end — we'll keep it rolling and adjust as we go.`,
    );
  } else {
    const distance = DISTANCE_LABEL[params.distance];
    const horizon =
      params.totalWeeks == null ? 'a rolling base block' : `~${ps.total_weeks} weeks of base and build`;
    lines.push(
      `Here's your starting plan: **building toward ${distance}, ${horizon}, growing from ~${startMi} ` +
        `to ~${peakMi} mi/wk, long runs on ${lrDay}.**`,
    );
    lines.push(
      "No race locked yet, so I've laid out base and build but held off on the taper — tell me the " +
        "race when you pick it and I'll anchor the calendar and add the peak.",
    );
  }

  if (params.timeGoalDiscouraged) {
    lines.push(
      "One thing: for where you are right now, I'd point you at finishing strong before chasing a " +
        'clock. We can set a time target down the road.',
    );
  }

  if (params.strengthSessionsPerWeek > 0) {
    const n = params.strengthSessionsPerWeek;
    lines.push(
      `I've also slotted in ${n} short strength session${n > 1 ? 's' : ''} a week — bodyweight for ` +
        'now. Not into it? Tap Skip strength.',
    );
  }

  return lines.join('\n\n');
}

const RETRY_KEYBOARD = new InlineKeyboard().text('Try again', 'plan:retry');
const FAIL_TEXT = "I hit a snag building your plan. Tap and I'll have another go.";

async function buildPreview(athleteId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const { plan, params } = await generateAndPersistPlan(athleteId);
  return { text: formatPreview(plan, params), keyboard: previewKeyboard(params) };
}

// Step entry: render + persist + show. Owns its own failure copy so the
// dispatcher's onEnter wrapper never has to (a thrown onEnter is last-resort).
async function onEnter(athleteId: string): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  try {
    return await buildPreview(athleteId);
  } catch (err) {
    console.error('[plan-preview] generate failed', err);
    await sendDavidAlert(`B1 plan generation failed for athlete ${athleteId}: ${String(err)}`).catch(
      () => {},
    );
    return { text: FAIL_TEXT, keyboard: RETRY_KEYBOARD };
  }
}

async function handleCallback(
  data: string,
  partial: Record<string, unknown>,
  athleteId: string,
): Promise<StepHandleResult> {
  if (data === 'plan:good') {
    // Advance to enrichment (its prompt is the next message). Plan stays active.
    return { done: true, newPartial: {} };
  }

  if (data === 'plan:adjust') {
    // Hand the just-generated plan to the worker coach. The coach reads it from
    // plan_versions at hydrate and customizes the working version. Seeded so it
    // makes one clear pass without demanding a reply mid-onboarding. The version
    // id keys the dedup so a double-tap / webhook retry enqueues once.
    const active = await getActiveTemplatePlan(athleteId);
    const versionId = active?.versionId ?? 'pending';
    await enqueueJob('tg_message', `tg_adjust:${athleteId}:${versionId}`, {
      athlete_id: athleteId,
      text:
        'I just finished onboarding and tapped "adjust the plan" on the starting plan you built me. ' +
        'Take a look, make one clear improvement if something stands out, and tell me briefly what ' +
        "you changed — we can fine-tune together once I'm set up, no need to ask me anything right now.",
    });
    return {
      done: true,
      newPartial: {},
      reply: "Good — I'll take a pass at it and message you in a moment. A couple of quick things first.",
    };
  }

  if (data === 'plan:nostrength') {
    const active = await getActiveTemplatePlan(athleteId);
    if (!active) {
      // No persisted plan (e.g. a prior generate failed). Re-show from scratch.
      const fresh = await onEnter(athleteId);
      return { done: false, newPartial: partial, reply: fresh.text, replyMarkup: fresh.keyboard };
    }
    const { plan, params } = await setPlanStrengthToZero(athleteId, active.versionId);
    return {
      done: false,
      newPartial: partial,
      reply: formatPreview(plan, params),
      replyMarkup: previewKeyboard(params),
    };
  }

  if (data === 'plan:retry') {
    const fresh = await onEnter(athleteId);
    return { done: false, newPartial: partial, reply: fresh.text, replyMarkup: fresh.keyboard };
  }

  return { done: false, newPartial: partial };
}

async function handleMessage(
  _text: string,
  partial: Record<string, unknown>,
): Promise<StepHandleResult> {
  return {
    done: false,
    newPartial: partial,
    reply: 'Tap a button above — Looks good if it works, or Adjust it and I’ll rework it with you.',
  };
}

export const planPreviewStep: OnboardingStep = {
  id: 'plan-preview',
  questions: [],
  onEnter,
  handleCallback,
  handleMessage,
  onComplete: async () => {
    // The plan is already persisted at onEnter; nothing to commit here.
  },
};
