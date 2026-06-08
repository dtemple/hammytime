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

// ---------------------------------------------------------------------------
// Race-day anchoring (T-1). A committed race must render exactly one type:'race'
// day, on the real race date, in the plan's final week.
// ---------------------------------------------------------------------------

function isoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isoWeekday(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

describe('race-day anchoring (T-1)', () => {
  it('Brenden: marathon-finish, 11 weeks out, race lands once on the real date', () => {
    // The reported prod failure: onboarded 2026-06-07 (Sun), Santa Rosa 2026-08-23
    // (Sun), long-run day Saturday. Before the fix this rendered race days on
    // 2026-08-08 and 2026-08-15 and ended 2026-08-16.
    const brenden: SelectorProfile = {
      experienceTier: 'some_training',
      goalDistance: 'marathon',
      daysPerWeek: 4,
      longRunDay: 6, // Saturday — deliberately ≠ the race weekday (Sunday)
      goalState: 'committed',
      targetDate: '2026-08-23',
      targetType: 'finish',
      targetTimeSec: null,
      race: { name: 'Santa Rosa Marathon', date: '2026-08-23', distanceMiles: 26.2, type: 'road' },
      injuries: [],
      today: '2026-06-07',
    };
    const { template, params } = selectPlan(brenden, SNAP, DRAFT_SAFETY_CAPS);
    // Inclusive count: mondayOf(06-07)=06-01 → mondayOf(08-23)=08-17 is 11 weeks, +1 = 12
    // (= the marathon-finish phase minimum), so base survives.
    expect(params.totalWeeks).toBe(12);

    const plan = renderPlan(template, params);
    const raceDays = plan.weeks.flatMap((w) => w.days).filter((d) => d.type === 'race');
    expect(raceDays).toHaveLength(1);
    expect(raceDays[0]!.date).toBe('2026-08-23');
    expect(plan.metadata.race.date).toBe('2026-08-23');

    const last = plan.weeks[plan.weeks.length - 1]!;
    expect(last.start_date! <= '2026-08-23' && '2026-08-23' <= last.end_date!).toBe(true);
    // The race is the long effort — no long run in the race week.
    expect(last.days.some((d) => d.type === 'long_run')).toBe(false);
  });

  // One representative selection per template that has a race phase.
  const RACE_TEMPLATE_CASES: Array<[string, GoalDistance, ExperienceTier]> = [
    ['marathon-finish', 'marathon', 'some_training'],
    ['marathon-performance', 'marathon', 'experienced'],
    ['half-foundation', 'half', 'beginner'],
    ['half-development', 'half', 'some_training'],
    ['short-race', '5k', 'for_fun'],
  ];
  const TODAY = '2026-06-08'; // a Monday

  function committedProfile(
    distance: GoalDistance,
    tier: ExperienceTier,
    raceDate: string,
    longRunDay: number,
  ): SelectorProfile {
    return {
      experienceTier: tier,
      goalDistance: distance,
      daysPerWeek: 4,
      longRunDay,
      goalState: 'committed',
      targetDate: raceDate,
      targetType: 'finish',
      targetTimeSec: null,
      race: { name: 'Goal Race', date: raceDate, distanceMiles: MILES[distance], type: 'road' },
      injuries: [],
      today: TODAY,
    };
  }

  for (const [label, distance, tier] of RACE_TEMPLATE_CASES) {
    it(`${label}: invariants hold across runways (race weekday = and ≠ long-run day)`, () => {
      const failures: string[] = [];
      for (let weeksOut = 4; weeksOut <= 24; weeksOut++) {
        // Vary the race weekday across the range so we cover weekend + midweek races.
        const raceDate = isoAddDays(TODAY, weeksOut * 7 + (weeksOut % 7));
        const rwd = isoWeekday(raceDate);
        for (const rel of ['same', 'diff'] as const) {
          const longRunDay = rel === 'same' ? rwd : (rwd + 3) % 7;
          const tag = `${label} ${weeksOut}wk/${rel}`;
          const { template, params } = selectPlan(
            committedProfile(distance, tier, raceDate, longRunDay),
            SNAP,
            DRAFT_SAFETY_CAPS,
          );

          // Invariant #2 — no phase exceeds maxWeeks; a present phase is ≥ minWeeks
          // (phases drop whole, from the front, rather than going under their min).
          const alloc = allocatePhases(template, params);
          const counts = new Map<string, number>();
          for (const a of alloc) counts.set(a.basePhase, (counts.get(a.basePhase) ?? 0) + 1);
          for (const phase of template.phases) {
            const c = counts.get(phase.name) ?? 0;
            if (phase.maxWeeks != null && c > phase.maxWeeks) {
              failures.push(`${tag}: ${phase.name}=${c} exceeds max ${phase.maxWeeks}`);
            }
            if (c > 0 && c < phase.minWeeks) {
              failures.push(`${tag}: ${phase.name}=${c} under min ${phase.minWeeks}`);
            }
          }

          let plan;
          try {
            plan = renderPlan(template, params); // throws via assertRaceDayInvariant on #1
          } catch (e) {
            failures.push(`${tag}: renderPlan threw — ${(e as Error).message}`);
            continue;
          }

          // Invariant #1 — exactly one race day, on the real date.
          const raceDays = plan.weeks.flatMap((w) => w.days).filter((d) => d.type === 'race');
          if (raceDays.length !== 1) {
            failures.push(`${tag}: ${raceDays.length} race days`);
          } else if (raceDays[0]!.date !== raceDate) {
            failures.push(`${tag}: race day ${raceDays[0]!.date} ≠ ${raceDate}`);
          }

          // Invariant #3 — the final week contains the race date; no long run there.
          const last = plan.weeks[plan.weeks.length - 1]!;
          if (!(last.start_date! <= raceDate && raceDate <= last.end_date!)) {
            failures.push(`${tag}: final week ${last.start_date}..${last.end_date} excludes race`);
          }
          if (last.days.some((d) => d.type === 'long_run')) {
            failures.push(`${tag}: long_run present in the race week`);
          }
          // Length: exact when the runway fits every phase minimum. When it can't, a
          // shorter correct plan is allowed (whole phases drop from the front rather
          // than overflowing a cap or going under a min) — but never longer than asked,
          // never empty.
          const minSum = template.phases.reduce((s, p) => s + p.minWeeks, 0);
          if (params.totalWeeks! >= minSum && plan.weeks.length !== params.totalWeeks) {
            failures.push(`${tag}: weeks ${plan.weeks.length} ≠ totalWeeks ${params.totalWeeks}`);
          }
          if (plan.weeks.length > params.totalWeeks! || plan.weeks.length < 1) {
            failures.push(`${tag}: weeks ${plan.weeks.length} out of range (totalWeeks ${params.totalWeeks})`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }
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
