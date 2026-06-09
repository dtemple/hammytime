import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { PlanSchema, DayTypeEnum, DaySchema } from './plan-schema';
import { PLAN_SHAPE_REFERENCE, TUPLE_RANGE_FIELDS } from './plan-shape-reference';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadCanonical(): unknown {
  const path = join(process.cwd(), 'seeds/marathon_training_plan.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// Gold-standard fixture: raw canonical plan parses cleanly, no adapter.
// ---------------------------------------------------------------------------

describe('PlanSchema — canonical plan (gold standard)', () => {
  it('raw plan parses cleanly — no adapter needed', () => {
    const raw = loadCanonical();
    const result = PlanSchema.safeParse(raw);
    if (!result.success) {
      console.error(
        'Parse errors:',
        result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    expect(result.success).toBe(true);
  });

  it('has 22 weeks matching metadata.plan_structure.total_weeks', () => {
    const plan = PlanSchema.parse(loadCanonical());
    expect(plan.metadata.plan_structure.total_weeks).toBe(22);
    expect(plan.weeks.length).toBe(22);
  });

  it('week 1 days is an array with 7 entries', () => {
    const plan = PlanSchema.parse(loadCanonical());
    expect(Array.isArray(plan.weeks[0]!.days)).toBe(true);
    expect(plan.weeks[0]!.days.length).toBe(7);
  });

  it('week 1 Monday is a long_run', () => {
    const plan = PlanSchema.parse(loadCanonical());
    const monday = plan.weeks[0]!.days.find((d) => d.day === 'Monday');
    expect(monday?.type).toBe('long_run');
  });

  it('all 9 day types from the canonical plan are accepted by the schema', () => {
    const plan = PlanSchema.parse(loadCanonical());
    const types = new Set(plan.weeks.flatMap((w) => w.days.map((d) => d.type)));
    const expected = [
      'long_run',
      'easy',
      'easy_with_strides',
      'hill_repeats',
      'trail_tempo',
      'upper_body_strength',
      'lower_body_strength',
      'race',
      'rest',
    ];
    for (const t of expected) {
      expect(types.has(t as never), `type "${t}" should be present`).toBe(true);
    }
  });

  it('agent_guidance is parsed and present', () => {
    const plan = PlanSchema.parse(loadCanonical());
    expect(plan.agent_guidance).toBeDefined();
    expect(plan.agent_guidance!.compliance_rules).toBeDefined();
    expect(plan.agent_guidance!.pace_zones).toBeDefined();
    expect(plan.agent_guidance!.modification_triggers).toBeDefined();
  });

  it('strength_workouts is parsed and present', () => {
    const plan = PlanSchema.parse(loadCanonical());
    expect(plan.strength_workouts).toBeDefined();
    expect(plan.strength_workouts!.upper_body).toBeDefined();
    expect(plan.strength_workouts!.lower_body).toBeDefined();
  });

  it('no top-level fields silently dropped', () => {
    const raw = loadCanonical() as Record<string, unknown>;
    const plan = PlanSchema.parse(raw);
    const rawKeys = Object.keys(raw).sort();
    const planKeys = Object.keys(plan).sort();
    for (const key of rawKeys) {
      expect(planKeys, `top-level key "${key}" should survive parse`).toContain(key);
    }
  });

  it('no week-level fields silently dropped (spot-check week 1)', () => {
    const raw = loadCanonical() as { weeks: Record<string, unknown>[] };
    const plan = PlanSchema.parse(raw);
    const rawWeek1 = raw.weeks[0]!;
    const parsedWeek1 = plan.weeks[0]!;
    const rawKeys = Object.keys(rawWeek1).sort();
    const parsedKeys = Object.keys(parsedWeek1).sort();
    for (const key of rawKeys) {
      expect(parsedKeys, `week-level key "${key}" should survive parse`).toContain(key);
    }
  });

  it('no day-level fields silently dropped (spot-check week 1 Monday)', () => {
    const raw = loadCanonical() as {
      weeks: { days: Record<string, unknown>[] }[];
    };
    const plan = PlanSchema.parse(raw);
    const rawDay = raw.weeks[0]!.days[0]!;
    const parsedDay = plan.weeks[0]!.days[0]!;
    const rawKeys = Object.keys(rawDay).sort();
    const parsedKeys = Object.keys(parsedDay).sort();
    for (const key of rawKeys) {
      expect(parsedKeys, `day-level key "${key}" should survive parse`).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Drift guard — the plan-shape reference handed to the coach (and the repair
// pass) must stay in sync with the schema it describes. If a day type or a
// tuple field changes here, this fails until the reference is updated.
// ---------------------------------------------------------------------------

describe('PLAN_SHAPE_REFERENCE — stays in sync with the schema', () => {
  it('names every legal day type', () => {
    for (const t of DayTypeEnum.options) {
      expect(PLAN_SHAPE_REFERENCE, `day type "${t}" should appear in the reference`).toContain(t);
    }
  });

  it('every field in TUPLE_RANGE_FIELDS is a [min, max] tuple on DaySchema', () => {
    const shape = DaySchema.shape as Record<string, z.ZodTypeAny>;
    for (const field of TUPLE_RANGE_FIELDS) {
      const def = shape[field];
      expect(def, `DaySchema should have a "${field}" field`).toBeDefined();
      const inner = def instanceof z.ZodOptional ? def.unwrap() : def;
      expect(inner instanceof z.ZodTuple, `"${field}" should be a tuple`).toBe(true);
    }
  });

  it('strides.count is a tuple (the shape the reference documents)', () => {
    const strides = DaySchema.shape.strides;
    const inner = strides instanceof z.ZodOptional ? strides.unwrap() : strides;
    expect(inner instanceof z.ZodObject).toBe(true);
    const count = (inner as z.ZodObject<{ count: z.ZodTypeAny }>).shape.count;
    expect(count instanceof z.ZodTuple).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural rejection tests — the schema must catch specific bad shapes.
// ---------------------------------------------------------------------------

describe('PlanSchema — rejects malformed plans', () => {
  it('rejects missing weeks array', () => {
    const result = PlanSchema.safeParse({
      metadata: {
        race: { name: 'x', date: '2026-01-01', distance_miles: 26.2 },
        plan_structure: { total_weeks: 1, start_date: '2025-12-25' },
      },
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join('.'));
    expect(paths.some((p) => p.includes('weeks'))).toBe(true);
  });

  it('rejects days as an object instead of array', () => {
    const raw = loadCanonical() as { weeks: { days: unknown }[] };
    // Replace week 1 days with an object
    raw.weeks[0]!.days = { mon: { type: 'easy', description: 'Easy.' } };
    const result = PlanSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid day type', () => {
    const raw = loadCanonical() as { weeks: { days: { type: string }[] }[] };
    raw.weeks[0]!.days[0]!.type = 'not_a_real_type';
    const result = PlanSchema.safeParse(raw);
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join('.'));
    expect(paths.some((p) => p.includes('days'))).toBe(true);
  });

  it('rejects weeks array length !== total_weeks', () => {
    const raw = loadCanonical() as { weeks: unknown[] };
    raw.weeks.pop(); // 21 weeks vs total_weeks: 22
    const result = PlanSchema.safeParse(raw);
    expect(result.success).toBe(false);
    const issues = result.error!.issues.map((i) => i.message).join(' ');
    expect(issues).toContain('total_weeks');
  });

  it("rejects goal='time' with no target_time_sec", () => {
    const raw = loadCanonical() as {
      metadata: { race: Record<string, unknown> };
    };
    raw.metadata.race.goal = 'time';
    delete raw.metadata.race.target_time_sec;
    const result = PlanSchema.safeParse(raw);
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join('.'));
    expect(paths.some((p) => p.includes('target_time_sec'))).toBe(true);
  });

  it('rejects phase coverage gap (a week number missing from all phases)', () => {
    const raw = loadCanonical() as {
      metadata: {
        plan_structure: {
          phases: { name: string; weeks: number[] }[];
        };
      };
    };
    // Remove week 5 from all phases — creates a gap
    raw.metadata.plan_structure.phases = raw.metadata.plan_structure.phases.map((p) => ({
      ...p,
      weeks: p.weeks.filter((w) => w !== 5),
    }));
    const result = PlanSchema.safeParse(raw);
    expect(result.success).toBe(false);
    const issues = result.error!.issues.map((i) => i.message).join(' ');
    expect(issues).toContain('phases');
  });
});
