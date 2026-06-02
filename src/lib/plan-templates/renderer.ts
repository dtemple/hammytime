// Plan renderer (onboarding v2, W3) — INTERFACE LAYER.
//
// Deterministically expands a (template + params) into a schema-valid `Plan`.
// No LLM in this path: initial plan-gen runs inline on the bot path for an
// instant B1 preview, and the output is always PlanSchema-valid. The worker
// coach agent customizes on top later (the [Adjust it] path), reading this
// Plan as a file. This file is the interface + the documented pipeline; the
// bodies land with the W3 build (most depend on the safety-cap numbers).

import type { PhaseName, Plan } from '@/lib/plan-schema';
import type { PlanTemplate, RenderParams, SafetyCaps } from './types';

/**
 * Expand a template + params into a schema-valid, safety-passing Plan.
 *
 * Pipeline:
 *   allocatePhases → buildWeeks → placeStrength → applyOverlays
 *   → PlanSchema.parse → validateSafety
 *
 * Always produces a schema-valid Plan. Safety is ADVISORY, not a refusal: the
 * renderer builds within the caps by default, and where the athlete's own
 * constraints force an aggressive plan (e.g. a marathon close to race day off a
 * low base), it builds the safest plan it can and the caller surfaces a clear
 * warning. It never refuses to produce a plan.
 */
export function renderPlan(template: PlanTemplate, params: RenderParams): Plan {
  void template;
  void params;
  throw new Error('renderPlan: not implemented (W3 build)');
}

// ---------------------------------------------------------------------------
// Pipeline steps — each is a pure function over (template, params) or a partial
// plan. Split out so each is independently unit-testable.
// ---------------------------------------------------------------------------

export interface PhaseAllocation {
  weekNumber: number;
  phase: PhaseName; // includes 'cutback' once relabeled
  isCutback: boolean;
}

/**
 * Allocate `params.totalWeeks` across the template's phases.
 *
 *   • Seed each phase at its minWeeks, distribute the remainder by `weight`
 *     (respecting maxWeeks), then relabel every Nth week (template.cutback) as
 *     phase 'cutback'.
 *   • Open-ended (params.totalWeeks === null): emit only phases with
 *     openEndedKeep (base + build) as an extendable block; peak/taper/race are
 *     added when a real date binds later.
 *   • totalWeeks < Σ minWeeks: over-compressed → compress proportionally and
 *     flag a warning (never refuse), don't silently drop phases.
 */
export function allocatePhases(template: PlanTemplate, params: RenderParams): PhaseAllocation[] {
  void template;
  void params;
  throw new Error('allocatePhases: not implemented (W3 build)');
}

/**
 * Expand the microcycle for each allocated week into `Plan['weeks']`:
 *   • pick the microcycle for params.runsPerWeek, rotate so the long run lands
 *     on params.longRunDay, and enforce caps.minEasyDaysBetweenHard spacing;
 *   • ramp weekly volume start→peak under caps.maxWeeklyRampPct, cutback-aware;
 *   • progress the long run (<= step caps, <= shareOfWeeklyMax of the week);
 *   • resolve each `quality` slot to a phase-appropriate workout from
 *     template.workoutMenu, resolving any [start,end] progression to one value;
 *   • attach concrete paces when params.targetTimeSec is set and the paceModel
 *     leads on pace.
 */
export function buildWeeks(
  template: PlanTemplate,
  params: RenderParams,
  allocation: PhaseAllocation[],
): Plan['weeks'] {
  void template;
  void params;
  void allocation;
  throw new Error('buildWeeks: not implemented (W3 build)');
}

/**
 * Slot strength sessions onto the week WITHOUT consuming run days: combine with
 * an easy day (or a standalone day) per template.strength.placement, up to
 * params.strengthSessionsPerWeek. Sessions stay bodyweight while
 * params.strengthEquipment is 'unknown'.
 */
export function placeStrength(weeks: Plan['weeks'], template: PlanTemplate, params: RenderParams): Plan['weeks'] {
  void weeks;
  void template;
  void params;
  throw new Error('placeStrength: not implemented (W3 build)');
}

/**
 * Apply overlays in params.overlays:
 *   • trail      — prefer_trail / include_elevation on long runs, swap
 *                  tempo→trail_tempo, emphasize hills, add power-hike + nutrition
 *                  practice on long runs, lead with HR over pace.
 *   • time_goal  — inject goal-pace segments into build/peak quality + long runs,
 *                  derive pace_zones from targetTimeSec. (Suppressed for the
 *                  foundation band — never selected there.)
 *   • injury     — apply params.injuryAccommodations (reduce volume, avoid day
 *                  types) lightly; the daily coach refines later.
 *   • open_ended — stamp the no-date framing onto coaching notes (peak/taper
 *                  deferred until a date binds).
 */
export function applyOverlays(plan: Plan, params: RenderParams): Plan {
  void plan;
  void params;
  throw new Error('applyOverlays: not implemented (W3 build)');
}

// ---------------------------------------------------------------------------
// Safety validator — DETECTS cap violations; it does not refuse. Policy is the
// caller's:
//   • gen-time: the renderer builds within caps, so a violation here is a bug —
//     fix/clamp before the plan becomes a plan_version.
//   • chat-time: the coach uses the violation to WARN the athlete with the
//     tradeoff and ask them to confirm, then writes the change. Never refuses.
// Now that shadow-bcc is gone, this is the only automated content check, so it's
// load-bearing — as a detector that drives an honest warning, not a silent gate.
// ---------------------------------------------------------------------------

export interface SafetyViolation {
  rule: string; // e.g. 'weekly_ramp', 'long_run_step', 'hard_day_spacing', 'long_run_cap'
  week?: number;
  detail: string;
}

export interface SafetyResult {
  ok: boolean;
  violations: SafetyViolation[];
}

/**
 * Verify a rendered plan against the caps:
 *   • week-over-week volume ramp <= caps.maxWeeklyRampPct (cutback-exempt);
 *   • long-run step <= caps.maxLongRunStepMi (postCutback exception);
 *   • long run <= caps.maxLongRunShareOfWeekly of its week;
 *   • long run <= caps.maxLongRunMiByDistance[distance];
 *   • >= caps.minEasyDaysBetweenHard easy/rest days between quality sessions.
 */
export function validateSafety(plan: Plan, caps: SafetyCaps): SafetyResult {
  void plan;
  void caps;
  throw new Error('validateSafety: not implemented (W3 build — pending safety-cap numbers)');
}
