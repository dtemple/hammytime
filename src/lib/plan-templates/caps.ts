// Safety caps — values locked for W3 (onboarding v2). Approved-with-tuning
// 2026-06-01; the numbers below are the settled launch values.
//
// Caps are ADVISORY, not refusals. The product manages the athlete's plan; it
// never makes the decision for them. Two moments:
//   • Generation (renderer): builds WITHIN the caps by default — the athlete
//     isn't requesting anything, so the cold-start plan is conservative.
//     `validateSafety` confirms the generated plan is in-bounds (a bug-catcher).
//   • Conversation (coach): caps are advisory. If the athlete asks for something
//     past a cap, the coach WARNS clearly with the tradeoff and asks them to
//     confirm — then complies and writes it. It NEVER refuses to update the plan.
//     ("A jump that size carries real injury risk; I'd strongly recommend
//     against it. But if you want it in your plan, I can do that.")
//
// One source of truth, one place the coach reads it: these caps flow into the
// worker coach prompt's safety-caps block (chat-time, via worker/system-prompt.ts).
// They used to ALSO be materialized into the rendered plan's
// agent_guidance.compliance_rules (gen-time), but that duplicated the same
// numbers in two surfaces the coach reads, so the renderer no longer emits them.
//
// Two-level design: each template carries a softer DESIGN TARGET (e.g.
// volume.longRun.shareOfWeeklyMax = 0.35) the renderer aims for in typical weeks;
// the caps below are the threshold past which the coach must warn + confirm.
//
// Sources: the existing canonical plan's agent_guidance.compliance_rules
// (long_run_progression, weekly_volume_cap) + standard endurance guidance.

import type { SafetyCaps } from './types';

export const DRAFT_SAFETY_CAPS: SafetyCaps = {
  // Week-over-week weekly-volume increase. Hybrid: a week may grow by the
  // GREATER of maxWeeklyRampPct or minWeeklyRampMi. The percentage governs at
  // higher volume; the absolute floor keeps low-mileage ramps from crawling
  // (10% of 15 mi/wk is 1.5 mi — glacial). Crossover is ~25 mi/wk (12% of 25 = 3).
  // NOTE for the validator: applies to the build trend only. Cutback weeks go
  // DOWN (exempt), and the week climbing back out of a cutback re-establishes
  // the prior peak (a big jump by construction) — exempt that re-ramp, cap only
  // progression to a NEW peak.
  maxWeeklyRampPct: 0.12,
  minWeeklyRampMi: 3,

  // Long-run week-over-week increase. Matches the canonical plan's
  // long_run_progression rule (~2 mi), with a 3 mi exception after a cutback.
  maxLongRunStepMi: 2,
  postCutbackLongRunStepMi: 3,

  // Long run as a fraction of the week. 0.50 is the warn/confirm threshold
  // (above ~half the week is an injury flag). Templates target 0.35. Low-volume
  // beginners sit naturally high here (a 20 mi week with a 10 mi long run is
  // already 0.50), which is why the cap is the threshold, not the target.
  maxLongRunShareOfWeekly: 0.5,

  // Easy/rest days required between two hard (quality) days — 48h between hard
  // efforts. 1 is the floor across all tiers.
  minEasyDaysBetweenHard: 1,

  // Absolute long-run ceiling per race distance. Templates cap at or below these
  // (e.g. marathon-finish longRun.capMi = 20 <= 22). Time-on-feet beyond these
  // costs more recovery than it returns for this audience.
  maxLongRunMiByDistance: {
    '5k': 8,
    '10k': 10,
    half: 15,
    marathon: 22, // performance ceiling; finish band caps itself at 20
    '50k': 26, // a marathon-distance long run is the ceiling for the bucket (ULTRA_SUPPORT §3.3)
    keep_fit: 14, // no race — keep maintenance from drifting toward ultra distance
  },
};
