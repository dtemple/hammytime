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
