// Baseline-vs-working plan drift.
//
// The coach edits a working copy of the plan in conversation (worker writes
// each settled edit as a new active plan_versions row). baseline_version_id
// still points at the original plan of record. This module diffs the two so the
// worker can hand the coach a plain-language summary of how far the plan has
// moved — surfaced as plan_drift.md in the athlete folder. Drift is measured in
// planned running miles (summed from day distances, robust to whether the agent
// kept planned_total_run_miles in sync) and in per-day workout changes.

import { isPlaceholderRace, type DayType, type Plan, type Week } from './plan-schema';
import { DRAFT_SAFETY_CAPS } from './plan-templates/caps';

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

// ---------------------------------------------------------------------------
// Race readiness — the macro "is the goal race still on?" signal.
//
// The drift summary above answers "how far has the plan moved from the
// original". This answers the question that matters once changes start to
// accumulate: given the moves so far and the runway left, can the athlete still
// reach the start line ready? It's the floor under the safety caps — the caps
// stop a change loading too much; this catches the opposite failure, where a
// long run keeps getting moved or cut for a niggle or a busy week, each step
// locally reasonable, until the buildup is quietly gone.
//
// The load-bearing variable for an endurance race is the long-run spine: the
// progression of long runs and the peak long run before the taper. This module
// reads that spine against the original plan and the weeks remaining, and emits
// a verdict the coach surfaces (in a change that touches the long run, and in
// the Sunday review). It renders only for a real, dated, still-upcoming goal
// race; a placeholder race (no-event / intended-no-date), a race already behind
// the athlete, or a plan with no long-run progression to read yields no signal.
//
// THRESHOLDS ARE DRAFT — flagged for David. Tune against real edit history.
// ---------------------------------------------------------------------------

// A long run within this many miles of the original peak counts as "intact".
const LR_TOLERANCE_MI = 1;
// A week's long run cut by at least this much vs the original counts as "lost".
const LR_LOST_MI = 3;
// Cumulative planned-running drop past this (percent) pulls an otherwise-intact
// spine down to WATCH — volume is bleeding even if the peak still stands.
const CUM_WATCH_PCT = 10;
// Weeks of taper assumed when a plan carries no taper/race phase — used to bound
// the build runway (you don't grow the long run into the final stretch).
const DEFAULT_TAPER_WEEKS = 2;

export type ReadinessVerdict = 'on_track' | 'watch' | 'at_risk';

export type Readiness = {
  raceName: string;
  raceDate: string;
  weeksToRace: number;
  baselinePeakMi: number; // the original plan's biggest long run
  baselinePeakWeek: number | null;
  longestAheadMi: number; // biggest long run still scheduled after today (working)
  longestAheadWeek: number | null;
  currentRungMi: number; // biggest long run already reached on/before today (working)
  buildWeeksLeft: number; // build weeks before the taper begins
  longRunsLost: number; // baseline long runs cut by >= LR_LOST_MI in the working plan
  cumulativeDeltaPct: number | null;
  verdict: ReadinessVerdict;
  reason: string;
};

type SpineWeek = { week_number: number; phase: string; miles: number; start?: string; end?: string };

// A week's long run: the longest `long_run`-typed day in it, or 0 when the week
// has none (cutback / taper / race weeks legitimately don't). Strict on type so
// a tempo or interval day is never mistaken for the long run.
function weekLongRunMiles(w: Week): number {
  const longs = w.days.filter((d) => d.type === 'long_run');
  if (longs.length === 0) return 0;
  return round1(Math.max(...longs.map((d) => d.planned_distance_miles ?? 0)));
}

function weekBounds(w: Week): { start?: string; end?: string } {
  const dates = w.days
    .map((d) => d.date)
    .filter((d): d is string => d !== undefined)
    .sort();
  return { start: w.start_date ?? dates[0], end: w.end_date ?? dates.at(-1) };
}

function longRunSpine(plan: Plan): SpineWeek[] {
  return [...plan.weeks]
    .sort((a, b) => a.week_number - b.week_number)
    .map((w) => ({ week_number: w.week_number, phase: w.phase, miles: weekLongRunMiles(w), ...weekBounds(w) }));
}

function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);
}

// Build weeks left before the taper. The first working taper/race week bounds
// it; with no taper phase on the plan, fall back to (weeks-to-race − a standard
// taper). Never negative — already in or past the taper means no build runway.
function buildWeeksBeforeTaper(spine: SpineWeek[], today: string, weeksToRace: number): number {
  const taper = spine.find((w) => (w.phase === 'taper' || w.phase === 'race') && (w.start ?? w.end));
  if (taper) {
    const taperStart = taper.start ?? taper.end!;
    if (taperStart <= today) return 0;
    return Math.max(0, Math.floor(daysBetween(today, taperStart) / 7));
  }
  return Math.max(0, weeksToRace - DEFAULT_TAPER_WEEKS);
}

/**
 * The macro readiness read for a dated, upcoming goal race. Pure and total —
 * returns null (no signal) for a placeholder race, a race on/before `today`, or
 * a plan whose long-run spine can't be read (no long_run days). `today` is the
 * athlete-local ISO date.
 */
export function computeReadiness(baseline: Plan, working: Plan, today: string): Readiness | null {
  const race = working.metadata?.race;
  if (!race || isPlaceholderRace(race) || !race.date) return null;
  if (race.date < today) return null; // already run — post-event pause owns this

  const baseSpine = longRunSpine(baseline);
  const workSpine = longRunSpine(working);

  const baselinePeakMi = round1(Math.max(0, ...baseSpine.map((w) => w.miles)));
  if (baselinePeakMi <= 0) return null; // no long-run progression to assess

  const weeksToRace = Math.max(0, Math.ceil(daysBetween(today, race.date) / 7));
  const baselinePeakWeek = baseSpine.find((w) => w.miles === baselinePeakMi)?.week_number ?? null;

  const ahead = workSpine.filter((w) => (w.end ?? w.start ?? '') >= today);
  const longestAheadMi = round1(Math.max(0, ...ahead.map((w) => w.miles)));
  const longestAheadWeek =
    ahead.find((w) => w.miles === longestAheadMi && w.miles > 0)?.week_number ?? null;

  const reached = workSpine.filter((w) => (w.end ?? w.start ?? '') <= today);
  const currentRungMi = round1(Math.max(0, ...reached.map((w) => w.miles)));

  const buildWeeksLeft = buildWeeksBeforeTaper(workSpine, today, weeksToRace);

  const baseByNum = new Map(baseSpine.map((w) => [w.week_number, w.miles]));
  let longRunsLost = 0;
  for (const w of workSpine) {
    const b = baseByNum.get(w.week_number);
    if (b !== undefined && round1(b - w.miles) >= LR_LOST_MI) longRunsLost++;
  }

  const cumulativeDeltaPct = computeDrift(baseline, working).cumulative.deltaPct;

  // The spine is intact when the biggest long run still scheduled ahead is
  // within tolerance of the original peak — the peak is still on the calendar.
  const peakGap = round1(baselinePeakMi - longestAheadMi);
  const spineIntact = peakGap <= LR_TOLERANCE_MI;
  // When it isn't, can the runway still rebuild it? Climb from the current rung
  // at the safety-cap long-run step across the build weeks left.
  const reachablePeak = round1(currentRungMi + buildWeeksLeft * DRAFT_SAFETY_CAPS.maxLongRunStepMi);
  const rebuildable = reachablePeak >= baselinePeakMi - LR_TOLERANCE_MI;

  const wk = (n: number) => `${n} build week${n === 1 ? '' : 's'}`;

  let verdict: ReadinessVerdict;
  let reason: string;
  if (spineIntact) {
    if (cumulativeDeltaPct !== null && cumulativeDeltaPct <= -CUM_WATCH_PCT) {
      verdict = 'watch';
      reason = `Long-run spine intact (the ${fmtMi(baselinePeakMi)} mi peak is still scheduled), but total planned running is down ${Math.abs(cumulativeDeltaPct)}% — keep volume from sliding further.`;
    } else {
      verdict = 'on_track';
      reason = `Long-run spine intact — the ${fmtMi(baselinePeakMi)} mi peak is still on the calendar ahead of race day.`;
    }
  } else if (rebuildable) {
    verdict = 'watch';
    reason = `Longest long run still scheduled (${fmtMi(longestAheadMi)} mi) is ${fmtMi(peakGap)} mi short of the original ${fmtMi(baselinePeakMi)} mi peak, but ${wk(buildWeeksLeft)} before the taper can rebuild it. Get the long run climbing again.`;
  } else {
    verdict = 'at_risk';
    reason = `The long-run peak has eroded to ${fmtMi(longestAheadMi)} mi scheduled vs ${fmtMi(baselinePeakMi)} mi originally, and ${wk(buildWeeksLeft)} left can't rebuild it before the taper. The original race target may no longer be realistic.`;
  }

  return {
    raceName: race.name,
    raceDate: race.date,
    weeksToRace,
    baselinePeakMi,
    baselinePeakWeek,
    longestAheadMi,
    longestAheadWeek,
    currentRungMi,
    buildWeeksLeft,
    longRunsLost,
    cumulativeDeltaPct,
    verdict,
    reason,
  };
}

const VERDICT_LABEL: Record<ReadinessVerdict, string> = {
  on_track: 'ON TRACK',
  watch: 'WATCH',
  at_risk: 'AT RISK',
};

export function renderReadiness(r: Readiness): string {
  const lines = [
    '# Race readiness',
    '',
    `Goal race: ${r.raceName} — ${r.weeksToRace} week${r.weeksToRace === 1 ? '' : 's'} out (${r.raceDate}).`,
    `Long-run spine: original peak ${fmtMi(r.baselinePeakMi)} mi${r.baselinePeakWeek ? ` (week ${r.baselinePeakWeek})` : ''}; longest still scheduled ahead ${fmtMi(r.longestAheadMi)} mi; biggest reached so far ${fmtMi(r.currentRungMi)} mi.`,
    `Build weeks before taper: ${r.buildWeeksLeft}. Long runs cut from the original: ${r.longRunsLost}.`,
    '',
    `Verdict: ${VERDICT_LABEL[r.verdict]} — ${r.reason}`,
  ];
  if (r.verdict === 'at_risk') {
    lines.push('');
    lines.push(
      'Put the fork to the athlete rather than accommodating again: hold the date and run a more conservative race (finish over a time goal, or run/walk), move the race to a later date, or change the goal. It is their call — but they can only make it if you name it.',
    );
  }
  return lines.join('\n') + '\n';
}
