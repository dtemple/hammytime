import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Day types — exactly the values that appear in the canonical plan.
// ---------------------------------------------------------------------------

export const DayTypeEnum = z.enum([
  'long_run',
  'easy',
  'easy_with_strides',
  'hill_repeats',
  'intervals', // flat road / track VO2 work (added v2 — road & short-race templates)
  'trail_tempo',
  'tempo', // flat road threshold work (added v2 — road & short-race templates)
  'upper_body_strength',
  'lower_body_strength',
  'race',
  'rest',
]);

export type DayType = z.infer<typeof DayTypeEnum>;

// ---------------------------------------------------------------------------
// Day — array item in week.days.
// Fields are a superset of what any single day uses; all are optional except
// the three required on every day (day, type, description).
// ---------------------------------------------------------------------------

export const DaySchema = z.object({
  day: z.string().min(1), // "Monday" … "Sunday"
  date: z.string().regex(ISO_DATE).optional(),
  type: DayTypeEnum,
  category: z.enum(['run', 'strength', 'rest', 'race']).optional(),
  description: z.string().min(1),

  // Run fields
  planned_distance_miles: z.number().nonnegative().optional(),
  intensity: z.string().optional(), // "easy" | "hard" | "moderate_hard" etc.
  target_hr_zone: z.tuple([z.number(), z.number()]).optional(),
  target_rpe: z.tuple([z.number(), z.number()]).optional(),
  prefer_trail: z.boolean().optional(),
  include_elevation: z.boolean().optional(),

  // Strength fields
  planned_duration_min: z.number().nonnegative().optional(),
  intensity_level: z.string().optional(), // "standard" | "taper" | "race_week"
  use_taper_sets: z.boolean().optional(),

  // easy_with_strides fields
  strides: z
    .object({
      count: z.tuple([z.number().int(), z.number().int()]),
      duration_sec: z.number().int().positive(),
      recovery: z.string(),
    })
    .optional(),

  // hill_repeats fields
  warmup_min: z.number().nonnegative().optional(),
  cooldown_min: z.number().nonnegative().optional(),
  repeats: z.number().int().positive().optional(),
  repeat_duration_sec: z.number().int().positive().optional(),
  recovery: z.string().optional(),
  target_hill_grade_percent: z.tuple([z.number(), z.number()]).optional(),
  uphill_hr_zone: z.tuple([z.number(), z.number()]).optional(),
  uphill_rpe: z.tuple([z.number(), z.number()]).optional(),

  // tempo / trail_tempo fields (shared — flat road `tempo` and trail `trail_tempo`)
  tempo_block_min: z.number().nonnegative().optional(),

  // intervals fields (reuses warmup_min/cooldown_min/repeats/repeat_duration_sec/
  // recovery above). repeat_distance_m is for distance-based reps (e.g. 5x1000m);
  // repeat_duration_sec for time-based (e.g. 5x3min).
  repeat_distance_m: z.number().positive().optional(),

  // Pace targeting — road and time-goal work. HR/RPE stay primary on trail and
  // effort-led (finish) plans; a concrete pace range is added when one applies.
  target_pace_sec_per_mile: z.tuple([z.number(), z.number()]).optional(),

  // race day fields
  elevation_gain_ft: z.number().nonnegative().optional(),
  target_strategy: z.string().optional(),

  // long_run coaching flags (weeks 9+)
  nutrition_note: z.string().optional(),
  nutrition_practice: z.boolean().optional(),
  power_hike_note: z.string().optional(),
  power_hike_practice: z.boolean().optional(),
});

export type Day = z.infer<typeof DaySchema>;

// ---------------------------------------------------------------------------
// Phase (inside metadata.plan_structure.phases)
// Uses a week-number list, not start/end ranges.
// ---------------------------------------------------------------------------

export const PhaseNameSchema = z.enum(['base', 'build', 'cutback', 'peak', 'taper', 'race']);

export type PhaseName = z.infer<typeof PhaseNameSchema>;

export const PhaseSchema = z.object({
  name: PhaseNameSchema,
  weeks: z.array(z.number().int().positive()).min(1),
  description: z.string().optional(),
});

export type Phase = z.infer<typeof PhaseSchema>;

// ---------------------------------------------------------------------------
// Week
// ---------------------------------------------------------------------------

export const WeekSchema = z.object({
  week_number: z.number().int().positive(),
  start_date: z.string().regex(ISO_DATE).optional(),
  end_date: z.string().regex(ISO_DATE).optional(),
  phase: PhaseNameSchema,
  planned_total_run_miles: z.number().nonnegative().optional(),
  coaching_note: z.string().optional(),
  days: z.array(DaySchema).min(1),
});

export type Week = z.infer<typeof WeekSchema>;

// ---------------------------------------------------------------------------
// Metadata — matches canonical plan's metadata object exactly.
// ---------------------------------------------------------------------------

const AthleteSchema = z.object({
  age: z.number().int().positive().optional(),
  sex: z.string().optional(),
  baseline_weekly_miles: z
    .object({ min: z.number().nonnegative(), max: z.number().nonnegative() })
    .optional(),
  baseline_long_run_miles: z.number().nonnegative().optional(),
});

const RaceSchema = z
  .object({
    name: z.string().min(1),
    date: z.string().regex(ISO_DATE, 'Must be ISO 8601 date'),
    day_of_week: z.string().optional(),
    distance_miles: z.number().positive(),
    type: z.enum(['road', 'trail', 'mixed']).optional(),
    elevation_gain_ft: z.number().nonnegative().optional(),
    goal: z.string().optional(), // "finish" | "time" | freeform
    target_time_sec: z.number().int().positive().optional(),
  })
  .refine((r) => r.goal !== 'time' || r.target_time_sec !== undefined, {
    message: 'target_time_sec is required when goal is "time"',
    path: ['target_time_sec'],
  });

const PlanStructureSchema = z.object({
  total_weeks: z.number().int().positive(),
  start_date: z.string().regex(ISO_DATE, 'Must be ISO 8601 date'),
  end_date: z.string().regex(ISO_DATE).optional(),
  days_per_week: z.number().int().min(1).max(7).optional(),
  rest_day: z.string().optional(),
  runs_per_week: z.number().int().nonnegative().optional(),
  strength_sessions_per_week: z.number().int().nonnegative().optional(),
  long_run_day: z.string().optional(),
  phases: z.array(PhaseSchema).optional(),
});

const MetadataSchema = z.object({
  athlete: AthleteSchema.optional(),
  race: RaceSchema,
  plan_structure: PlanStructureSchema,
});

// ---------------------------------------------------------------------------
// Agent guidance — fully typed; compliance_rules is a heterogeneous array
// where each rule shares rule_id/description/action with optional extras.
// ---------------------------------------------------------------------------

const PaceZoneSchema = z.object({
  description: z.string(),
  hr_zone: z.tuple([z.number(), z.number()]),
  hr_percent_max: z.tuple([z.number(), z.number()]),
  rpe: z.tuple([z.number(), z.number()]),
  // Concrete pace range (sec/mile) — present on road / time-goal plans where pace
  // leads. Effort-led (trail / finish) plans leave this off and use HR/RPE.
  pace_sec_per_mile: z.tuple([z.number(), z.number()]).optional(),
});

const ComplianceRuleSchema = z.object({
  rule_id: z.string(),
  description: z.string(),
  action: z.string(),
  threshold_percent: z.number().optional(),
  condition: z.string().optional(),
  max_increase_miles: z.number().optional(),
  exception: z.string().optional(),
  target: z.string().optional(),
});

const AgentGuidanceSchema = z.object({
  description: z.string().optional(),
  pace_zones: z
    .object({
      note: z.string().optional(),
      easy: PaceZoneSchema,
      long_run: PaceZoneSchema,
      tempo: PaceZoneSchema,
      hill_repeat: PaceZoneSchema.optional(), // trail / hill plans only
      interval: PaceZoneSchema.optional(), // road / short-race VO2 plans
      marathon_pace: PaceZoneSchema.optional(), // time-goal marathon / half
      strides: PaceZoneSchema,
    })
    .optional(),
  compliance_rules: z.array(ComplianceRuleSchema).optional(),
  modification_triggers: z
    .object({
      feeling_great: z.string(),
      feeling_fatigued: z.string(),
      time_crunched: z.string(),
      weather_disruption: z.string(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Strength workouts — typed to the two sessions in the canonical plan.
// Exercise entries are heterogeneous: most have sets/reps; Foam Rolling has
// duration_min/areas. All variant fields are optional.
// ---------------------------------------------------------------------------

const ExerciseSchema = z.object({
  name: z.string(),
  sets: z.number().int().positive().optional(),
  reps: z.number().optional(),
  reps_unit: z.string().optional(), // "per_side" | "per_leg" | "seconds" | …
  taper_sets: z.number().int().optional(),
  taper_reps: z.number().optional(),
  muscle_group: z.string().optional(),
  trail_note: z.string().optional(),
  duration_min: z.number().nonnegative().optional(), // Foam Rolling
  taper_duration_min: z.number().nonnegative().optional(),
  areas: z.array(z.string()).optional(), // Foam Rolling areas
});

const StrengthSessionSchema = z.object({
  day: z.string(),
  standard_duration_min: z.number().nonnegative(),
  taper_duration_min: z.number().nonnegative(),
  race_week_duration_min: z.number().nonnegative(),
  exercises: z.array(ExerciseSchema),
});

const StrengthWorkoutsSchema = z.object({
  upper_body: StrengthSessionSchema.optional(),
  lower_body: StrengthSessionSchema.optional(),
});

// ---------------------------------------------------------------------------
// Plan (root) — matches the canonical plan's top-level shape exactly.
//
// Refinements:
//   1. weeks.length === metadata.plan_structure.total_weeks
//   2. If phases are present, their week numbers cover 1..total_weeks exactly once.
// ---------------------------------------------------------------------------

export const PlanSchema = z
  .object({
    $schema: z.string().optional(),
    plan_version: z.string().optional(),
    created: z.string().optional(),
    metadata: MetadataSchema,
    agent_guidance: AgentGuidanceSchema.optional(),
    strength_workouts: StrengthWorkoutsSchema.optional(),
    weeks: z.array(WeekSchema).min(1),
  })
  .refine((p) => p.weeks.length === p.metadata.plan_structure.total_weeks, {
    message: 'weeks array length must equal metadata.plan_structure.total_weeks',
    path: ['weeks'],
  })
  .refine(
    (p) => {
      const phases = p.metadata.plan_structure.phases;
      if (!phases || phases.length === 0) return true;
      const totalWeeks = p.metadata.plan_structure.total_weeks;
      const covered = new Array(totalWeeks + 1).fill(0);
      for (const ph of phases) {
        for (const w of ph.weeks) {
          if (w >= 1 && w <= totalWeeks) covered[w]++;
        }
      }
      return covered.slice(1).every((c) => c === 1);
    },
    {
      message:
        'metadata.plan_structure.phases must cover every week from 1 to total_weeks exactly once (no gaps, no overlaps)',
      path: ['metadata', 'plan_structure', 'phases'],
    },
  );

export type Plan = z.infer<typeof PlanSchema>;
