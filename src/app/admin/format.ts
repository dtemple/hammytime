// Small presentation helpers shared by the admin roster + detail pages.
// Plain functions + Tailwind class strings — no component library (anti-goal §5).

import { dollarsLabel } from '@/server/billing/pricing';

/** "+$5" / "−$2.50" / "$0" — signed money for ledger amounts (U+2212 minus). */
export function signedDollars(cents: number): string {
  if (cents === 0) return '$0';
  const sign = cents > 0 ? '+' : '−';
  return `${sign}${dollarsLabel(Math.abs(cents))}`;
}

/** "$18.40" / "−$1.05" — a balance that may be negative (overshoot, §5). */
export function balanceLabel(cents: number): string {
  return cents < 0 ? `−${dollarsLabel(-cents)}` : dollarsLabel(cents);
}

export type StatusChip = { label: string; className: string };

/**
 * The status chips for an athlete — pause state surfaced DISTINCTLY from
 * out-of-credit (§11): "on vacation" reads differently from "$0", and an
 * auto-inactivity pause differently from a manual one. An athlete can carry more
 * than one (e.g. paused AND out of credit).
 */
export function statusChips(s: {
  comped: boolean;
  balanceCents: number;
  pausedAt: string | null;
  pauseReason: string | null;
}): StatusChip[] {
  const chips: StatusChip[] = [];
  if (s.comped) chips.push({ label: 'comped', className: 'bg-purple-100 text-purple-800' });
  if (s.pausedAt) {
    chips.push(
      s.pauseReason === 'auto_inactivity'
        ? { label: 'paused · inactive', className: 'bg-amber-100 text-amber-800' }
        : { label: 'paused · vacation', className: 'bg-blue-100 text-blue-800' },
    );
  }
  if (!s.comped && s.balanceCents <= 0) {
    chips.push({ label: 'out of credit', className: 'bg-red-100 text-red-800' });
  }
  if (chips.length === 0) {
    chips.push({ label: 'active', className: 'bg-green-100 text-green-800' });
  }
  return chips;
}

/** "~3 days" until inactivity auto-pause, "due" when overdue, "—" when N/A. */
export function autoPauseCell(days: number | null): string {
  if (days == null) return '—';
  if (days <= 0) return 'due';
  if (days < 1) return '<1 day';
  const n = Math.round(days);
  return `~${n} ${n === 1 ? 'day' : 'days'}`;
}

/** "about 5 weeks" runway, or an em-dash when there's nothing to show. */
export function runwayCell(
  comped: boolean,
  balanceCents: number,
  runwayDays: number | null,
): string {
  if (comped) return '—';
  if (balanceCents <= 0) return 'out';
  if (runwayDays == null) return '—';
  if (runwayDays < 1) return '<1 day';
  if (runwayDays < 10) return `~${Math.round(runwayDays)} days`;
  return `~${Math.round(runwayDays / 7)} weeks`;
}
