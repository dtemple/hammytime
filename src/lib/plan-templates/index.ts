// Plan template library — public surface (onboarding v2, W3).
//
// This barrel + registry wires the module together so callers import one place.
// It does NOT touch the live onboarding route — that's W4 (plan preview / adjust
// loop), and it waits on the renderer bodies (still stubbed). What's wired here:
// the template registry, the (distance × tier) selector, and the composed
// `selectPlan` entry point.

export * from './types';
export * from './selector';
export * from './renderer';
export { DRAFT_SAFETY_CAPS } from './caps';

import type { PlanTemplate, RenderParams, SafetyCaps, TemplateId } from './types';
import {
  computeRenderParams,
  selectTemplateId,
  type FitnessSnapshotInput,
  type SelectorProfile,
} from './selector';
import { marathonFinish } from './templates/marathon-finish';

/** Authored templates by id. The other five (marathon-performance,
 *  half-foundation, half-development, short-race, base-maintenance) are pending
 *  in W3 — `getTemplate` throws a clear error until they land. */
export const TEMPLATES: Partial<Record<TemplateId, PlanTemplate>> = {
  'marathon-finish': marathonFinish,
};

export function getTemplate(id: TemplateId): PlanTemplate {
  const template = TEMPLATES[id];
  if (!template) {
    throw new Error(`getTemplate: template "${id}" is not authored yet (W3)`);
  }
  return template;
}

/**
 * Compose selection: profile + Strava snapshot → the chosen template and the
 * render params for it. `computeRenderParams` is still stubbed (W3 build), so
 * this throws there until the renderer build lands — the wiring is in place,
 * the behavior follows.
 */
export function selectPlan(
  profile: SelectorProfile,
  snapshot: FitnessSnapshotInput | null,
  caps: SafetyCaps,
): { templateId: TemplateId; template: PlanTemplate; params: RenderParams } {
  const templateId = selectTemplateId(profile.goalDistance, profile.experienceTier);
  const template = getTemplate(templateId);
  const params = computeRenderParams(profile, snapshot, caps);
  return { templateId, template, params };
}
