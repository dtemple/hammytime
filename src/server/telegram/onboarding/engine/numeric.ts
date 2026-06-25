// Onboarding v3 (V3-W2): the deterministic numeric plausibility backstop (§5.1).
//
// The live transcript's worst stretch was a numeric-extraction loop: "10 minute
// miles for a marathon" → a wrong total, "4:25" → four minutes for a marathon.
// Sonnet does the unit reasoning and the pace→finish arithmetic in the tool call;
// this module is the code-side guard that the spec insists on ("not prompt-only,
// because Haiku flubbed exactly this"). It validates a proposed finish time
// against sane per-distance ranges and, when a value is ambiguous, hands the
// router the two interpretations to offer as chips rather than guessing.

import { nominalRaceMiles } from '@/lib/plan-templates/selector';
import { formatFinishTime } from '../parsing/durations';
import { FINISH_TIME_RANGES_SEC, type GoalDistanceValue } from '../slots/schema';

/** A finish time the model resolved, checked against the distance's plausible
 *  band. `ambiguous` means a small value (e.g. "4:25") reads as either hours or
 *  minutes — the router offers both as chips. */
export type FinishTimeResolution =
  | { status: 'ok'; seconds: number }
  | { status: 'out_of_range'; seconds: number }
  | {
      status: 'ambiguous';
      asHours: { seconds: number; label: string };
      asMinutes: { seconds: number; label: string };
    }
  | { status: 'no_range' }; // distance has no finish-time band (keep_fit)

/** Finish-time plausibility for a CONCRETE distance: a pace envelope rather than
 *  a per-bucket table, so any real distance — a 1-mile goal, a 44-mile run — gets
 *  a sane band in one expression (ULTRA_SUPPORT §3.2 decision #7; bounds DRAFT). */
export const PACE_ENVELOPE_SEC_PER_MI = { min: 230, max: 1500 }; // ~3:50 – ~25:00 /mi

/**
 * Validate a proposed finish time (seconds) for a distance against
 * FINISH_TIME_RANGES_SEC. When the value is small enough that it could be a
 * "H:MM" that the model read as "MM:SS" (or vice-versa), and exactly one of the
 * two interpretations lands in range, surface both as an ambiguity so the router
 * disambiguates with chips instead of committing a guess.
 */
export function resolveFinishTime(
  seconds: number,
  distance: GoalDistanceValue,
): FinishTimeResolution {
  const range = FINISH_TIME_RANGES_SEC[distance];
  if (!range) return { status: 'no_range' };
  return resolveAgainstRange(seconds, range);
}

/** The pace-envelope variant for a pocketed goal's REAL distance (R1 fix 5):
 *  "sub-5 for the mile" is implausible against the 5k bucket band but fine
 *  against 1 mi × the envelope. Same ambiguity handling as the bucket path. */
export function resolveFinishTimeForMiles(seconds: number, miles: number): FinishTimeResolution {
  if (!Number.isFinite(miles) || miles <= 0) return { status: 'no_range' };
  return resolveAgainstRange(seconds, {
    min: Math.round(miles * PACE_ENVELOPE_SEC_PER_MI.min),
    max: Math.round(miles * PACE_ENVELOPE_SEC_PER_MI.max),
  });
}

function resolveAgainstRange(
  seconds: number,
  range: { min: number; max: number },
): FinishTimeResolution {
  const inRange = (s: number) => s >= range.min && s <= range.max;

  // The classic "4:25" case: the model may report 265 (4m25s) when the athlete
  // meant 4:25:00 (15900s). The hours reading multiplies the minutes/seconds
  // figure by 60. Only treat as ambiguous when the given value is itself too
  // small to be plausible but its hours reading is in range.
  if (!inRange(seconds)) {
    const asHours = seconds * 60; // reinterpret MM:SS as H:MM
    if (seconds < range.min && inRange(asHours)) {
      return {
        status: 'ambiguous',
        asHours: { seconds: asHours, label: formatFinishTime(asHours) },
        asMinutes: { seconds, label: formatFinishTime(seconds) },
      };
    }
    return { status: 'out_of_range', seconds };
  }

  return { status: 'ok', seconds };
}

/** The catalog floor (DRAFT — R1): below this, a distance is out of catalog on
 *  the SHORT side and routes to the pocket, mirroring the >28 mi ceiling. The
 *  Nathan transcript's 1-mile goal silently became a 5K because no floor existed. */
export const CATALOG_FLOOR_MI = 2.5;

/**
 * Map a concrete race/goal distance (miles) to a training bucket IN CODE — the
 * deterministic derivation the model never does (V3-W8, ONBOARDING_V3 §5.3). A
 * confirmed race's `distance_mi`, or a stated distance the model surfaced, runs
 * through here; the model only maps freeform distance *vocabulary* when no number
 * exists. Bands are wide on purpose — a 27-mile trail "marathon" trains like a
 * marathon, a 35-miler trains like a 50k (the full table lives in ULTRA_SUPPORT.md
 * §3.1). The catalog tops at the 50k (V4-W4 / U1): 28–40 mi is the 50k bucket.
 * Returns null for anything outside the catalog — below ~2.5 mi routes to the
 * short-side pocket (5k proxy); past ~40 mi routes to the beyond-50k off-ramp (no
 * proxy plan — the athlete is asked for a shorter event). `keep_fit` is never
 * derived from miles (it's a no-race state).
 */
export function deriveBucketFromMiles(mi: number): GoalDistanceValue | null {
  if (!Number.isFinite(mi) || mi <= 0) return null;
  if (mi < CATALOG_FLOOR_MI) return null; // out of catalog (short) → the 5k pocket
  if (mi < 4.65) return '5k'; // 5k=3.1, 10k=6.2 → split at the midpoint
  if (mi < 8) return '10k';
  if (mi < 17) return 'half';
  if (mi <= 28) return 'marathon';
  if (mi <= 40) return '50k'; // 28–40 trains as a long trail marathon
  return null; // beyond the 50k → the off-ramp (no proxy plan; V4-W4)
}

/** Implied finish time for a goal pace (seconds per mile) over a distance.
 *  Lets the engine turn "10 minute miles for a marathon" into ~4:22. */
export function paceToFinish(secPerMile: number, distance: GoalDistanceValue): number {
  return Math.round(secPerMile * nominalRaceMiles(distance));
}

/** Implied goal pace (seconds per mile) for a finish time over a distance. */
export function finishToPace(finishSec: number, distance: GoalDistanceValue): number {
  return Math.round(finishSec / nominalRaceMiles(distance));
}

/** Format seconds-per-mile as M:SS/mi. */
export function formatPace(secPerMile: number): string {
  const m = Math.floor(secPerMile / 60);
  const s = Math.round(secPerMile % 60);
  return `${m}:${String(s).padStart(2, '0')}/mi`;
}

/** Today's date as YYYY-MM-DD in a timezone (en-CA formats ISO-style). Mirrors
 *  plan-gen's todayInTz — duplicated so guardrails/commit don't pull plan-gen
 *  into their static graph (the router lazy-imports it deliberately). */
export function todayISOInTz(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    // A junk timezone slot value must not crash the turn.
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a value is a full ISO date strictly before today. Non-ISO strings
 *  (e.g. an intended-branch placeholder) are never "past". */
export function isPastISODate(value: string, todayISO: string): boolean {
  return ISO_DATE.test(value) && value < todayISO;
}
