// Baseline-vs-working plan drift.
//
// The coach edits a working copy of the plan in conversation (worker writes
// each settled edit as a new active plan_versions row). baseline_version_id
// still points at the original plan of record. This module diffs the two so the
// worker can hand the coach a plain-language summary of how far the plan has
// moved — surfaced as plan_drift.md in the athlete folder. Drift is measured in
// planned running miles (summed from day distances, robust to whether the agent
// kept planned_total_run_miles in sync) and in per-day workout changes.

import type { DayType, Plan, Week } from './plan-schema';

type DayState = { type: DayType; miles: number };

export type DayChange = {
  date: string | null;
  day: string;
  from: DayState | null; // null = no matching day in the baseline week
  to: DayState | null; // null = the day was dropped in the working plan
};

export type WeekDrift = {
  week_number: number;
  phase: string;
  baselineMiles: number;
  workingMiles: number;
  deltaMiles: number; // working − baseline
  deltaPct: number | null; // null when baseline is 0
  changedDays: DayChange[];
};

export type PlanDrift = {
  hasEdits: boolean;
  cumulative: {
    baselineMiles: number;
    workingMiles: number;
    deltaMiles: number;
    deltaPct: number | null;
  };
  weeks: WeekDrift[]; // only weeks that changed
  changedWeekCount: number;
  changedDayCount: number;
};

const EPS = 0.01;

function dayMiles(d: { planned_distance_miles?: number }): number {
  return d.planned_distance_miles ?? 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function weekMiles(week: Week): number {
  return round1(week.days.reduce((sum, d) => sum + dayMiles(d), 0));
}

function pct(baseline: number, working: number): number | null {
  if (baseline < EPS) return null;
  return Math.round(((working - baseline) / baseline) * 100);
}

// Key a day within its week. Date is unique per day in practice; fall back to
// the weekday name so the diff still aligns if a plan omits dates.
function dayKey(d: { date?: string; day: string }): string {
  return d.date ?? d.day;
}

function dayState(d: { type: DayType; planned_distance_miles?: number }): DayState {
  return { type: d.type, miles: round1(dayMiles(d)) };
}

function sameState(a: DayState | null, b: DayState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.type === b.type && Math.abs(a.miles - b.miles) < EPS;
}

function diffWeek(baseline: Week | undefined, working: Week | undefined): WeekDrift | null {
  // A week present in only one plan is summarized against an empty counterpart.
  const week_number = (working ?? baseline)!.week_number;
  const phase = (working ?? baseline)!.phase;
  const baselineMiles = baseline ? weekMiles(baseline) : 0;
  const workingMiles = working ? weekMiles(working) : 0;

  const baseDays = new Map((baseline?.days ?? []).map((d) => [dayKey(d), d]));
  const workDays = new Map((working?.days ?? []).map((d) => [dayKey(d), d]));

  const changedDays: DayChange[] = [];
  // Iterate the union of keys, working order first.
  const keys = [...workDays.keys(), ...[...baseDays.keys()].filter((k) => !workDays.has(k))];
  for (const key of keys) {
    const w = workDays.get(key);
    const b = baseDays.get(key);
    const from = b ? dayState(b) : null;
    const to = w ? dayState(w) : null;
    if (!sameState(from, to)) {
      const ref = w ?? b!;
      changedDays.push({ date: ref.date ?? null, day: ref.day, from, to });
    }
  }

  const changed = changedDays.length > 0 || Math.abs(workingMiles - baselineMiles) >= EPS;
  if (!changed) return null;

  return {
    week_number,
    phase,
    baselineMiles,
    workingMiles,
    deltaMiles: round1(workingMiles - baselineMiles),
    deltaPct: pct(baselineMiles, workingMiles),
    changedDays,
  };
}

export function computeDrift(baseline: Plan, working: Plan): PlanDrift {
  const baseWeeks = new Map(baseline.weeks.map((w) => [w.week_number, w]));
  const workWeeks = new Map(working.weeks.map((w) => [w.week_number, w]));

  const allWeekNumbers = [...new Set([...baseWeeks.keys(), ...workWeeks.keys()])].sort(
    (a, b) => a - b,
  );

  const weeks: WeekDrift[] = [];
  for (const n of allWeekNumbers) {
    const drift = diffWeek(baseWeeks.get(n), workWeeks.get(n));
    if (drift) weeks.push(drift);
  }

  const baselineMiles = round1(baseline.weeks.reduce((s, w) => s + weekMiles(w), 0));
  const workingMiles = round1(working.weeks.reduce((s, w) => s + weekMiles(w), 0));
  const changedDayCount = weeks.reduce((s, w) => s + w.changedDays.length, 0);

  return {
    hasEdits: weeks.length > 0,
    cumulative: {
      baselineMiles,
      workingMiles,
      deltaMiles: round1(workingMiles - baselineMiles),
      deltaPct: pct(baselineMiles, workingMiles),
    },
    weeks,
    changedWeekCount: weeks.length,
    changedDayCount,
  };
}

// ---------------------------------------------------------------------------
// Rendering — the plain-language summary the coach reads.
// ---------------------------------------------------------------------------

function fmtMi(n: number): string {
  const r = round1(n);
  return Number.isInteger(r) ? `${r}` : r.toFixed(1);
}

function fmtSignedMi(n: number): string {
  const r = round1(n);
  return `${r >= 0 ? '+' : '−'}${fmtMi(Math.abs(r))} mi`;
}

function fmtSignedPct(n: number | null): string {
  if (n === null) return '';
  return ` (${n >= 0 ? '+' : '−'}${Math.abs(n)}%)`;
}

function fmtState(s: DayState | null): string {
  if (s === null) return '—';
  return s.miles > EPS ? `${s.type} ${fmtMi(s.miles)}mi` : s.type;
}

export function renderDriftSummary(drift: PlanDrift): string {
  const lines: string[] = ['# Plan drift — working plan vs. your original'];

  if (!drift.hasEdits) {
    lines.push('');
    lines.push('Working plan matches your original — no drift.');
    return lines.join('\n') + '\n';
  }

  const c = drift.cumulative;
  lines.push('');
  lines.push(
    `Cumulative planned running: ${fmtMi(c.workingMiles)} mi working vs ${fmtMi(c.baselineMiles)} mi original (${fmtSignedMi(c.deltaMiles)}${fmtSignedPct(c.deltaPct)}).`,
  );
  lines.push(`Weeks changed: ${drift.changedWeekCount}. Days changed: ${drift.changedDayCount}.`);

  for (const w of drift.weeks) {
    lines.push('');
    lines.push(
      `## Week ${w.week_number} (${w.phase}) — ${fmtMi(w.workingMiles)} mi vs ${fmtMi(w.baselineMiles)} mi (${fmtSignedMi(w.deltaMiles)}${fmtSignedPct(w.deltaPct)})`,
    );
    for (const d of w.changedDays) {
      const label = d.date ? `${d.day} ${d.date}` : d.day;
      lines.push(`- ${label}: ${fmtState(d.from)} → ${fmtState(d.to)}`);
    }
  }

  return lines.join('\n') + '\n';
}
