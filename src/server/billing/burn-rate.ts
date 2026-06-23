// Metering & payments — burn rate + runway estimate (Specs/METERING_PAYMENTS.md §8).
//
// Turns an athlete's recent spend into "about N weeks at your pace" for /balance and
// the topup confirmation. Step 5's low-balance warnings reuse this same helper.
//
// §8 specifies a trailing-14-day average, but athlete_cost_rollup only exposes 7d/28d
// windows. We use the 7d window (cost_usd_7d / 7) — a single read of the existing view,
// no migration, weighted to recent behavior. (Deviation from §8's 14-day basis is
// deliberate and noted in the spec.) cost_usd in the rollup is RAW model cost; we apply
// the §2 markup via billedCents so there's no second copy of the 1.5× anywhere.

import { supabaseAdmin } from '@/lib/db';
import { billedCents } from './pricing';

// The §2/§8 measured friends-only fallback for athletes too new to estimate from.
// Kept here in one place; update it when the measured average moves.
export const DEFAULT_BILLED_PER_DAY_CENTS = 80;

// An athlete needs at least this much history before we trust their own average
// over the default — a day or two of runs isn't a representative pace.
const MIN_HISTORY_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Billed cents/day this athlete is burning, from the rollup's 7d window. Falls back
 * to DEFAULT_BILLED_PER_DAY_CENTS for an athlete with no rollup row, fewer than
 * MIN_HISTORY_DAYS of history, or no measured 7d spend. Always returns a positive
 * integer (the default floor), so runway division never hits zero.
 */
export async function getBilledBurnPerDayCents(athleteId: string): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from('athlete_cost_rollup')
    .select('first_run_at, cost_usd_7d')
    .eq('athlete_id', athleteId)
    .maybeSingle();
  if (error) throw error;

  if (!data?.first_run_at) return DEFAULT_BILLED_PER_DAY_CENTS;

  const historyMs = Date.now() - new Date(data.first_run_at).getTime();
  if (historyMs < MIN_HISTORY_DAYS * DAY_MS) return DEFAULT_BILLED_PER_DAY_CENTS;

  const raw7d = data.cost_usd_7d ?? 0;
  if (raw7d <= 0) return DEFAULT_BILLED_PER_DAY_CENTS;

  // billedCents floors at 0; a sub-cent/day pace that rounds to 0 falls back to the default.
  return billedCents(raw7d / 7) || DEFAULT_BILLED_PER_DAY_CENTS;
}

/** Days of runway left at the athlete's current pace. balanceCents may be 0/negative
 *  (overshoot, §5) — callers clamp the display, not this. */
export async function estimateRunwayDays(
  balanceCents: number,
  athleteId: string,
): Promise<number> {
  const perDay = await getBilledBurnPerDayCents(athleteId);
  return balanceCents / perDay;
}

/**
 * Humanized runway for bot copy: "about 4 days" / "about a week" / "about 5 weeks".
 * Loose on purpose — it's a pace estimate, not a guarantee. Non-positive runway
 * (already out / overshot) has no sensible "time left", so callers should special-case
 * $0 rather than label it; this clamps to "less than a day" as a backstop.
 */
export function runwayLabel(days: number): string {
  if (days < 1) return 'less than a day left';
  if (days < 6.5) {
    const n = Math.round(days);
    return `about ${n} ${n === 1 ? 'day' : 'days'}`;
  }
  if (days < 10) return 'about a week';
  const weeks = Math.round(days / 7);
  return `about ${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
}
