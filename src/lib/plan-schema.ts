import { z } from "zod";

// ---------------------------------------------------------------------------
// DayPlan
// ---------------------------------------------------------------------------

export const DayPlanSchema = z.object({
  type: z.enum([
    "long_run",
    "easy",
    "tempo",
    "hills",
    "track",
    "race",
    "strength",
    "cross",
    "rest",
  ]),
  distance_mi: z.number().positive().optional(),
  duration_min: z.number().nonnegative().optional(),
  intensity_rpe: z.number().min(1).max(10).optional(),
  description: z.string().min(1),
  notes: z.string().optional(),
});

export type DayPlan = z.infer<typeof DayPlanSchema>;

// ---------------------------------------------------------------------------
// Week days
// ---------------------------------------------------------------------------

const WeekDaysSchema = z.object({
  mon: DayPlanSchema,
  tue: DayPlanSchema,
  wed: DayPlanSchema,
  thu: DayPlanSchema,
  fri: DayPlanSchema,
  sat: DayPlanSchema,
  sun: DayPlanSchema,
});

// ---------------------------------------------------------------------------
// Phase name enum (shared between phases array and weeks)
// ---------------------------------------------------------------------------

export const PhaseNameSchema = z.enum([
  "base",
  "build",
  "cutback",
  "peak",
  "taper",
  "race",
]);

export type PhaseName = z.infer<typeof PhaseNameSchema>;

// ---------------------------------------------------------------------------
// Phase entry
// ---------------------------------------------------------------------------

export const PhaseSchema = z.object({
  name: PhaseNameSchema,
  start_week: z.number().int().positive(),
  end_week: z.number().int().positive(),
  focus: z.string().min(1),
});

export type Phase = z.infer<typeof PhaseSchema>;

// ---------------------------------------------------------------------------
// Week
// ---------------------------------------------------------------------------

export const WeekSchema = z.object({
  week_number: z.number().int().positive(),
  phase: PhaseNameSchema,
  focus: z.string().min(1),
  planned_volume_mi: z.number().nonnegative(),
  planned_elevation_ft: z.number().nonnegative(),
  key_notes: z.string(),
  days: WeekDaysSchema,
});

export type Week = z.infer<typeof WeekSchema>;

// ---------------------------------------------------------------------------
// Goal race
// ---------------------------------------------------------------------------

const GoalRaceSchema = z
  .object({
    name: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be ISO 8601 date"),
    distance_mi: z.number().positive(),
    elevation_ft: z.number().nonnegative(),
    terrain: z.enum(["road", "trail", "mixed"]),
    target: z.enum(["finish", "time"]),
    target_time_sec: z.number().int().positive().optional(),
  })
  .refine(
    (r) => r.target !== "time" || r.target_time_sec !== undefined,
    { message: 'target_time_sec is required when target is "time"', path: ["target_time_sec"] }
  );

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const MetaSchema = z.object({
  athlete_name: z.string().min(1),
  goal_race: GoalRaceSchema,
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be ISO 8601 date"),
  total_weeks: z.number().int().positive(),
  weekly_availability: z.object({
    days_per_week: z.number().int().min(1).max(7),
    hours_per_week: z.number().positive(),
  }),
});

// ---------------------------------------------------------------------------
// Compliance rules
// ---------------------------------------------------------------------------

const ComplianceRulesSchema = z.object({
  hard_day_min_spacing_days: z.number().int().positive(),
  max_week_volume_ramp_pct: z.number().positive(),
  min_rest_days_per_week: z.number().int().nonnegative(),
  long_run_cap_pct_of_week: z.number().positive(),
  cutback_week_frequency: z.number().int().positive(),
  cutback_volume_reduction_pct_min: z.number().positive(),
  cutback_volume_reduction_pct_max: z.number().positive(),
});

// ---------------------------------------------------------------------------
// Race strategy
// ---------------------------------------------------------------------------

const RaceStrategySchema = z.object({
  pacing_approach: z.string().min(1),
  fueling_approach: z.string().min(1),
  key_landmarks_to_brief: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Plan (root) — with refinements
// ---------------------------------------------------------------------------

export const PlanSchema = z
  .object({
    schema_version: z.literal(1),
    meta: MetaSchema,
    phases: z.array(PhaseSchema).min(1),
    weeks: z.array(WeekSchema).min(1),
    compliance_rules: ComplianceRulesSchema,
    race_strategy: RaceStrategySchema,
  })
  .refine(
    (p) => p.weeks.length === p.meta.total_weeks,
    { message: "weeks array length must equal meta.total_weeks", path: ["weeks"] }
  )
  .refine(
    (p) => {
      // Every week 1..total_weeks must be covered by exactly one phase
      const totalWeeks = p.meta.total_weeks;
      const covered = new Array(totalWeeks + 1).fill(0); // index by week_number
      for (const ph of p.phases) {
        for (let w = ph.start_week; w <= ph.end_week; w++) {
          if (w >= 1 && w <= totalWeeks) covered[w]++;
        }
      }
      return covered.slice(1).every((c) => c === 1);
    },
    {
      message:
        "phases must cover every week from 1 to total_weeks exactly once (no gaps, no overlaps)",
      path: ["phases"],
    }
  );

export type Plan = z.infer<typeof PlanSchema>;
