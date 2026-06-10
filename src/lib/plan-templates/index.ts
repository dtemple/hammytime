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
export * from './continuation';
export { DRAFT_SAFETY_CAPS } from './caps';

import type { PlanTemplate, RenderParams, SafetyCaps, TemplateId } from './types';
import {
  computeRenderParams,
  selectTemplateId,
  type FitnessSnapshotInput,
  type SelectorProfile,
} from './selector';
import { marathonFinish } from './templates/marathon-finish';
import { marathonPerformance } from './templates/marathon-performance';
import { halfFoundation } from './templates/half-foundation';
import { halfDevelopment } from './templates/half-development';
import { shortRace } from './templates/short-race';
import { baseMaintenance } from './templates/base-maintenance';

/** All six authored templates by id. */
export const TEMPLATES: Record<TemplateId, PlanTemplate> = {
  'marathon-finish': marathonFinish,
  'marathon-performance': marathonPerformance,
  'half-foundation': halfFoundation,
  'half-development': halfDevelopment,
  'short-race': shortRace,
  'base-maintenance': baseMaintenance,
};

export function getTemplate(id: TemplateId): PlanTemplate {
  return TEMPLATES[id];
}

/**
 * Compose selection: profile + Strava snapshot → the chosen template and the
 * render params for it. The resolved template is threaded into
 * `computeRenderParams` (it reads the template's volume floors, strength
 * defaults, supported microcycles, and overlays) — passing it here avoids a
 * circular import between the selector and this registry.
 */
export function selectPlan(
  profile: SelectorProfile,
  snapshot: FitnessSnapshotInput | null,
  caps: SafetyCaps,
): { templateId: TemplateId; template: PlanTemplate; params: RenderParams } {
  const templateId = selectTemplateId(profile.goalDistance, profile.experienceTier);
  const template = getTemplate(templateId);
  const params = computeRenderParams(profile, snapshot, caps, template);
  return { templateId, template, params };
}
