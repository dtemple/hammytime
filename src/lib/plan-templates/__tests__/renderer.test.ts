import { describe, it, expect } from 'vitest';
import { PlanSchema } from '@/lib/plan-schema';
import {
  selectPlan,
  renderPlan,
  allocatePhases,
  buildWeeks,
  validateSafety,
  computeRenderParams,
  getTemplate,
  DRAFT_SAFETY_CAPS,
} from '../index';
import type { ExperienceTier, GoalDistance, TemplateId } from '../types';
import type { FitnessSnapshotInput, SelectorProfile } from '../selector';

const SNAP: FitnessSnapshotInput = {
  recentWeeklyMileageMi: 26,
  avgWeeklyMileageMi: 24,
  longestRunMi: 9,
  runsPerWeek: 4,
  suggestedDaysPerWeek: 4,
  dominantLongRunWeekday: 0,
  roadTrailMix: { road: 0.85, trail: 0.15 },
};

const MILES: Record<GoalDistance, number> = {
  '5k': 3.1,
  '10k': 6.2,
  half: 13.1,
  marathon: 26.2,
  keep_fit: 5,
};

type GoalState = 'committed' | 'intended-date' | 'intended-nodate';

function buildProfile(
  distance: GoalDistance,
  tier: ExperienceTier,
  state: GoalState,
  opts: { time?: number; trail?: boolean; injuries?: string[] } = {},
): SelectorProfile {
  const isKeepFit = distance === 'keep_fit';
  const goalState = isKeepFit ? 'day_to_day' : state === 'committed' ? 'committed' : 'intended';
  const targetDate = state === 'intended-nodate' || isKeepFit ? null : '2026-10-04';
  const committed = state === 'committed' && !isKeepFit;
  return {
    experienceTier: tier,
    goalDistance: distance,
    daysPerWeek: 4,
    longRunDay: 0, // Sunday
    goalState,
    targetDate,
    targetType: opts.time ? 'time' : 'finish',
    targetTimeSec: opts.time ?? null,
    race: committed
      ? {
          name: 'Test Race',
          date: '2026-10-04',
          distanceMiles: MILES[distance],
          type: opts.trail ? 'trail' : 'road',
        }
      : null,
    injuries: (opts.injuries ?? []).map((bodyPart) => ({ bodyPart })),
    today: '2026-06-08',
  };
}

// (templateId, distance, tier) — one representative selection per template.
const TEMPLATE_CASES: Array<[TemplateId | string, GoalDistance, ExperienceTier]> = [
  ['marathon-finish', 'marathon', 'some_training'],
  ['marathon-performance', 'marathon', 'experienced'],
  ['half-foundation', 'half', 'beginner'],
  ['half-development', 'half', 'some_training'],
  ['short-race(5k)', '5k', 'for_fun'],
  ['short-race(10k)', '10k', 'experienced'],
  ['base-maintenance', 'keep_fit', 'experienced'],
];

const GOAL_STATES: GoalState[] = ['committed', 'intended-date', 'intended-nodate'];

describe('renderPlan — 6 templates × 3 goal states produce valid, safety-passing plans', () => {
  for (const [label, distance, tier] of TEMPLATE_CASES) {
    for (const state of GOAL_STATES) {
      it(`${label} / ${state}`, () => {
        const profile = buildProfile(distance, tier, state);
        const { template, params } = selectPlan(profile, SNAP, DRAFT_SAFETY_CAPS);
        const plan = renderPlan(template, params);

        const parsed = PlanSchema.safeParse(plan);
        if (!parsed.success) {
          console.error(
            `${label}/${state} schema errors:`,
            parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
          );
        }
        expect(parsed.success).toBe(true);

        const safety = validateSafety(plan, DRAFT_SAFETY_CAPS, distance);
        if (!safety.ok) {
          console.error(
            `${label}/${state} safety violations:`,
            safety.violations.map((v) => `w${v.week} ${v.rule}: ${v.detail}`),
          );
        }
        expect(safety.ok).toBe(true);

        // structural sanity
        expect(plan.weeks.length).toBe(plan.metadata.plan_structure.total_weeks);
        for (const week of plan.weeks) {
          expect(week.days.length).toBe(7);
        }
      });
    }
  }
});

describe('renderPlan — overlays stay valid and safe', () => {
  it('time goal (marathon-performance) attaches paces and stays safe', () => {
    const profile = buildProfile('marathon', 'experienced', 'committed', {
      time: 3 * 3600 + 15 * 60,
    });
    const { template, params } = selectPlan(profile, SNAP, DRAFT_SAFETY_CAPS);
    expect(params.overlays).toContain('time_goal');
    const plan = renderPlan(template, params);
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    expect(validateSafety(plan, DRAFT_SAFETY_CAPS, 'marathon').ok).toBe(true);
    // a concrete goal-race pace lands on the marathon_pace zone
    expect(plan.agent_guidance?.pace_zones?.marathon_pace?.pace_sec_per_mile).toBeDefined();
    // and on some quality day in the build
    const hasPace = plan.weeks.some((w) => w.days.some((d) => d.target_pace_sec_per_mile));
    expect(hasPace).toBe(true);
  });

  it('trail overlay flags long runs and stays safe', () => {
    const profile = buildProfile('marathon', 'some_training', 'committed', { trail: true });
    const { template, params } = selectPlan(profile, SNAP, DRAFT_SAFETY_CAPS);
    expect(params.overlays).toContain('trail');
    const plan = renderPlan(template, params);
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    expect(validateSafety(plan, DRAFT_SAFETY_CAPS, 'marathon').ok).toBe(true);
    const trailLong = plan.weeks.some((w) =>
      w.days.some((d) => d.type === 'long_run' && d.prefer_trail),
    );
    expect(trailLong).toBe(true);
  });

  it('injury overlay swaps flagged day types and stays safe', () => {
    const profile = buildProfile('marathon', 'experienced', 'committed', {
      injuries: ['achilles'],
    });
    const { template, params } = selectPlan(profile, SNAP, DRAFT_SAFETY_CAPS);
    expect(params.overlays).toContain('injury');
    const plan = renderPlan(template, params);
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    expect(validateSafety(plan, DRAFT_SAFETY_CAPS, 'marathon').ok).toBe(true);
    // achilles → no hill_repeats anywhere
    const hasHills = plan.weeks.some((w) => w.days.some((d) => d.type === 'hill_repeats'));
    expect(hasHills).toBe(false);
  });
});

describe('allocatePhases', () => {
  it('covers weeks 1..N exactly once, including relabeled cutbacks', () => {
    const t = getTemplate('marathon-finish');
    const params = computeRenderParams(
      buildProfile('marathon', 'some_training', 'committed'),
      SNAP,
      DRAFT_SAFETY_CAPS,
      t,
    );
    const alloc = allocatePhases(t, params);
    expect(alloc.length).toBe(params.totalWeeks);
    const weekNums = alloc.map((a) => a.weekNumber).sort((a, b) => a - b);
    expect(weekNums).toEqual([...Array(alloc.length).keys()].map((i) => i + 1));
    expect(alloc.some((a) => a.isCutback)).toBe(true);
    // cutbacks only land on base/build/peak structural phases
    for (const a of alloc) {
      if (a.isCutback) expect(['base', 'build', 'peak']).toContain(a.basePhase);
    }
  });

  it('open-ended emits only base + build (no peak/taper/race)', () => {
    const t = getTemplate('marathon-finish');
    const params = computeRenderParams(
      buildProfile('marathon', 'some_training', 'intended-nodate'),
      SNAP,
      DRAFT_SAFETY_CAPS,
      t,
    );
    const alloc = allocatePhases(t, params);
    const phases = new Set(alloc.map((a) => a.basePhase));
    expect(phases.has('peak')).toBe(false);
    expect(phases.has('taper')).toBe(false);
    expect(phases.has('race')).toBe(false);
    expect(phases.has('base')).toBe(true);
    expect(phases.has('build')).toBe(true);
  });
});

describe('buildWeeks', () => {
  it('puts the long run on the athlete’s chosen weekday', () => {
    const t = getTemplate('marathon-finish');
    const profile = buildProfile('marathon', 'some_training', 'committed');
    profile.longRunDay = 6; // Saturday
    const params = computeRenderParams(profile, SNAP, DRAFT_SAFETY_CAPS, t);
    const alloc = allocatePhases(t, params);
    const weeks = buildWeeks(t, params, alloc);
    const wk = weeks[1]!; // a build-ish week
    const longRun = wk.days.find((d) => d.type === 'long_run');
    expect(longRun?.day).toBe('Saturday');
  });
});

describe('caps surface into agent_guidance.compliance_rules', () => {
  it('includes the three caps-derived rules with the locked numbers', () => {
    const profile = buildProfile('marathon', 'some_training', 'committed');
    const { template, params } = selectPlan(profile, SNAP, DRAFT_SAFETY_CAPS);
    const plan = renderPlan(template, params);
    const rules = plan.agent_guidance?.compliance_rules ?? [];
    const byId = Object.fromEntries(rules.map((r) => [r.rule_id, r]));
    expect(byId['long_run_progression']?.max_increase_miles).toBe(
      DRAFT_SAFETY_CAPS.maxLongRunStepMi,
    );
    expect(byId['weekly_volume_cap']?.threshold_percent).toBe(
      Math.round(DRAFT_SAFETY_CAPS.maxWeeklyRampPct * 100),
    );
    expect(byId['long_run_distance_cap']).toBeDefined();
    expect(byId['long_run_distance_cap']?.description).toContain(
      String(DRAFT_SAFETY_CAPS.maxLongRunMiByDistance.marathon),
    );
  });
});

describe('strength placement', () => {
  it('adds the tier-default strength sessions without consuming run days', () => {
    const profile = buildProfile('marathon', 'experienced', 'committed'); // performance → 2 strength
    const { template, params } = selectPlan(profile, SNAP, DRAFT_SAFETY_CAPS);
    const plan = renderPlan(template, params);
    const wk = plan.weeks.find((w) => w.phase === 'build') ?? plan.weeks[1]!;
    const runDays = wk.days.filter((d) => d.category === 'run').length;
    const strengthDays = wk.days.filter((d) => d.category === 'strength').length;
    expect(runDays).toBe(params.runsPerWeek);
    // 4 run days leaves 3 non-run slots, so both default strength sessions fit.
    expect(strengthDays).toBe(params.strengthSessionsPerWeek);
  });
});
