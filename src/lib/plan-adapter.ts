/**
 * plan-adapter.ts
 *
 * Adapts the personal-coach marathon_training_plan.json (plan_version: "2.0")
 * to the canonical hammytime Plan shape (schema_version: 1).
 *
 * This is intentionally dumb: direct field renames + structural normalization
 * only. No business logic. If the input is already canonical (schema_version:
 * 1) it's passed through PlanSchema.parse unchanged. Any unrecognized shape
 * throws with a clear error.
 *
 * Export: adaptLegacyPlan(rawJson: unknown, opts?: { athleteName?: string })
 */

import { PlanSchema, type Plan, type PhaseName } from "./plan-schema";

// ---------------------------------------------------------------------------
// Day name → canonical key
// ---------------------------------------------------------------------------

const DAY_NAME_MAP: Record<string, keyof Plan["weeks"][0]["days"]> = {
  Monday: "mon",
  Tuesday: "tue",
  Wednesday: "wed",
  Thursday: "thu",
  Friday: "fri",
  Saturday: "sat",
  Sunday: "sun",
};

// ---------------------------------------------------------------------------
// Internal types for the health-agent plan shape
// ---------------------------------------------------------------------------

interface HealthAgentDay {
  day: string;
  date?: string;
  type: string;
  category?: string;
  description?: string;
  planned_distance_miles?: number;
  intensity?: string;
  target_hr_zone?: number[];
  target_rpe?: number | number[];
  prefer_trail?: boolean;
  include_elevation?: boolean;
}

interface HealthAgentWeek {
  week_number: number;
  start_date?: string;
  end_date?: string;
  phase: string;
  planned_total_run_miles?: number;
  coaching_note?: string;
  days: HealthAgentDay[];
}

interface HealthAgentPhase {
  name: string;
  weeks: number[];
  description?: string;
}

interface HealthAgentRace {
  name: string;
  date: string;
  distance_miles?: number;
  type?: string;
  elevation_gain_ft?: number;
  goal?: string;
  target_time_sec?: number;
}

interface HealthAgentPlanStructure {
  total_weeks: number;
  start_date: string;
  days_per_week?: number;
  hours_per_week?: number;
  phases?: HealthAgentPhase[];
}

interface HealthAgentPlan {
  plan_version: string;
  metadata: {
    athlete?: { age?: number; sex?: string };
    race?: HealthAgentRace;
    plan_structure?: HealthAgentPlanStructure;
  };
  agent_guidance?: unknown;
  strength_workouts?: unknown;
  weeks: HealthAgentWeek[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adaptDay(raw: HealthAgentDay): Plan["weeks"][0]["days"]["mon"] {
  // target_rpe can be a single number or a [min, max] range — take the first.
  let intensity_rpe: number | undefined;
  if (raw.target_rpe !== undefined) {
    if (Array.isArray(raw.target_rpe)) {
      intensity_rpe = raw.target_rpe[0];
    } else {
      intensity_rpe = raw.target_rpe;
    }
  }

  // Skip distance_mi when 0 — rest days in the personal-coach plan have
  // planned_distance_miles: 0, but the schema requires a positive number.
  const distance_mi =
    typeof raw.planned_distance_miles === "number" &&
    raw.planned_distance_miles > 0
      ? raw.planned_distance_miles
      : undefined;

  return {
    type: raw.type as Plan["weeks"][0]["days"]["mon"]["type"],
    description: raw.description ?? raw.type,
    ...(distance_mi !== undefined ? { distance_mi } : {}),
    ...(intensity_rpe !== undefined ? { intensity_rpe } : {}),
  };
}

function adaptWeekDays(
  rawDays: HealthAgentDay[]
): Plan["weeks"][0]["days"] {
  const result: Partial<Plan["weeks"][0]["days"]> = {};

  for (const raw of rawDays) {
    const key = DAY_NAME_MAP[raw.day];
    if (!key) {
      throw new Error(
        `Unrecognized day name "${raw.day}" — expected Monday–Sunday.`
      );
    }
    result[key] = adaptDay(raw);
  }

  // Confirm all 7 days are present.
  const required: Array<keyof Plan["weeks"][0]["days"]> = [
    "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  ];
  for (const k of required) {
    if (!result[k]) {
      throw new Error(`Missing day "${k}" in week — days array is incomplete.`);
    }
  }

  return result as Plan["weeks"][0]["days"];
}

function adaptPhases(rawPhases: HealthAgentPhase[]): Plan["phases"] {
  // The personal-coach format stores phases as explicit week-number lists which
  // can be non-contiguous (e.g. cutback: [4, 8, 12, 16]). The hammytime schema
  // uses {start_week, end_week} ranges — using min/max would create overlapping
  // ranges that fail the phase-coverage refinement.
  //
  // Solution: decompose each phase's week list into contiguous runs. A 22-week
  // plan with 4 cutback weeks at [4,8,12,16] becomes 4 single-week entries
  // instead of one spanning 4→16.
  const entries: Plan["phases"] = [];

  for (const p of rawPhases) {
    const sorted = [...p.weeks].sort((a, b) => a - b);
    let runStart = sorted[0];
    let runEnd = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === runEnd + 1) {
        runEnd = sorted[i];
      } else {
        entries.push({
          name: p.name as PhaseName,
          start_week: runStart,
          end_week: runEnd,
          focus: p.description,
        });
        runStart = sorted[i];
        runEnd = sorted[i];
      }
    }
    entries.push({
      name: p.name as PhaseName,
      start_week: runStart,
      end_week: runEnd,
      focus: p.description,
    });
  }

  // Sort by start_week so the phases array reads chronologically.
  return entries.sort((a, b) => a.start_week - b.start_week);
}

// ---------------------------------------------------------------------------
// Main transform: health-agent format → canonical Plan
// ---------------------------------------------------------------------------

function fromHealthAgent(
  raw: HealthAgentPlan,
  opts: { athleteName?: string }
): Plan {
  const { metadata, weeks: rawWeeks, agent_guidance, strength_workouts } = raw;
  const race = metadata.race ?? ({} as HealthAgentRace);
  const ps = metadata.plan_structure ?? ({} as HealthAgentPlanStructure);

  // Meta
  const meta: Plan["meta"] = {
    ...(opts.athleteName ? { athlete_name: opts.athleteName } : {}),
    goal_race: {
      name: race.name ?? "Unknown race",
      date: race.date ?? "",
      distance_mi: race.distance_miles ?? 26.2,
      elevation_ft: race.elevation_gain_ft ?? 0,
      terrain: (race.type ?? "road") as "road" | "trail" | "mixed",
      target: (race.goal ?? "finish") as "finish" | "time",
      ...(race.target_time_sec !== undefined
        ? { target_time_sec: race.target_time_sec }
        : {}),
    },
    start_date: ps.start_date ?? "",
    total_weeks: ps.total_weeks ?? rawWeeks.length,
    weekly_availability: {
      days_per_week: ps.days_per_week ?? 6,
      ...(ps.hours_per_week !== undefined
        ? { hours_per_week: ps.hours_per_week }
        : {}),
    },
  };

  // Phases
  const rawPhases = ps.phases ?? [];
  const phases = adaptPhases(rawPhases);

  // Weeks
  const weeks: Plan["weeks"] = rawWeeks.map((w) => ({
    week_number: w.week_number,
    phase: w.phase as PhaseName,
    planned_volume_mi: w.planned_total_run_miles ?? 0,
    key_notes: w.coaching_note ?? "",
    days: adaptWeekDays(w.days),
  }));

  // Race strategy: absent from personal-coach plan; inject SHIM.
  const race_strategy: Plan["race_strategy"] = {
    pacing_approach:
      // v0.6 SHIM — fill once we have plan-gen or athlete self-report.
      "TBD",
    fueling_approach:
      // v0.6 SHIM — fill once we have plan-gen or athlete self-report.
      "TBD",
    key_landmarks_to_brief: [],
  };

  const adapted: Plan = {
    schema_version: 1,
    meta,
    phases,
    weeks,
    race_strategy,
    ...(agent_guidance !== undefined ? { agent_guidance } : {}),
    ...(strength_workouts !== undefined ? { strength_workouts } : {}),
  };

  // Validate before returning — throws with clear Zod messages if the adapter
  // produced something still invalid.
  return PlanSchema.parse(adapted);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AdaptOptions {
  /** Athlete's name to inject into meta.athlete_name (optional). */
  athleteName?: string;
}

/**
 * adaptLegacyPlan
 *
 * Takes any raw JSON, determines its format, and returns a valid Plan.
 *
 * - schema_version: 1 → already canonical, pass through PlanSchema.parse.
 * - plan_version: "2.0" → health-agent format, transform.
 * - anything else → throw.
 */
export function adaptLegacyPlan(rawJson: unknown, opts: AdaptOptions = {}): Plan {
  if (typeof rawJson !== "object" || rawJson === null) {
    throw new Error("Unrecognized plan format — input is not an object.");
  }

  const raw = rawJson as Record<string, unknown>;

  // Already canonical
  if (raw.schema_version === 1) {
    return PlanSchema.parse(raw);
  }

  // Health-agent format
  if (typeof raw.plan_version === "string" || typeof raw.plan_version === "number") {
    return fromHealthAgent(raw as unknown as HealthAgentPlan, opts);
  }

  throw new Error(
    'Unrecognized plan format — expected schema_version: 1 or plan_version field. ' +
    `Got top-level keys: ${Object.keys(raw).join(", ")}.`
  );
}
