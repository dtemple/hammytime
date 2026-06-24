// Metering & payments — read models for the David-only admin console
// (Specs/METERING_PAYMENTS.md §11, step 7). Pure composition over the existing
// billing tables + helpers; the mutations (adjust, comped toggle) live in
// credits.ts. Console-only, so it's kept out of the hot-path credits module.

import { supabaseAdmin } from '@/lib/db';
import { estimateRunwayDays } from './burn-rate';

/** One row of the roster table: an athlete + their live billing/pause state. */
export type RosterRow = {
  athleteId: string;
  name: string;
  telegramChatId: string | null;
  /** Negative chat id = the David test/group row (§4) — flagged, not hidden. */
  isTest: boolean;
  /** 0 when the athlete has no athlete_credits row yet. */
  balanceCents: number;
  hasCreditsRow: boolean;
  comped: boolean;
  pausedAt: string | null;
  pauseReason: string | null;
  /** Days of runway at current pace; null when comped (billing off). */
  runwayDays: number | null;
};

/**
 * The whole roster, ordered by balance ascending so the athletes closest to $0
 * (the ones who may need a nudge or a top-up) sort to the top. Comped and
 * no-credits-row athletes sort with a balance of 0.
 */
export async function getRoster(): Promise<RosterRow[]> {
  const db = supabaseAdmin();

  const { data: athletes, error: aErr } = await db
    .from('athletes')
    .select('id, name, telegram_chat_id, paused_at, pause_reason')
    .order('name', { ascending: true });
  if (aErr) throw aErr;

  const { data: credits, error: cErr } = await db
    .from('athlete_credits')
    .select('athlete_id, balance_cents, comped');
  if (cErr) throw cErr;

  const creditsById = new Map((credits ?? []).map((c) => [c.athlete_id as string, c]));

  const rows: RosterRow[] = [];
  for (const a of athletes ?? []) {
    const credit = creditsById.get(a.id as string);
    const balanceCents = credit?.balance_cents ?? 0;
    const comped = credit?.comped ?? false;
    // Runway is meaningless for a comped athlete (nothing draws down).
    const runwayDays = comped ? null : await estimateRunwayDays(balanceCents, a.id as string);
    const chatId = (a.telegram_chat_id as string | null) ?? null;
    rows.push({
      athleteId: a.id as string,
      name: a.name as string,
      telegramChatId: chatId,
      isTest: !!chatId && chatId.startsWith('-'),
      balanceCents,
      hasCreditsRow: !!credit,
      comped,
      pausedAt: (a.paused_at as string | null) ?? null,
      pauseReason: (a.pause_reason as string | null) ?? null,
      runwayDays,
    });
  }

  rows.sort((x, y) => x.balanceCents - y.balanceCents);
  return rows;
}

export type LedgerRow = {
  id: string;
  kind: string;
  amountCents: number;
  balanceAfterCents: number;
  note: string | null;
  relatedRunId: string | null;
  stripePaymentIntent: string | null;
  createdAt: string;
};

export type AthleteDetail = {
  athleteId: string;
  name: string;
  telegramChatId: string | null;
  isTest: boolean;
  balanceCents: number;
  hasCreditsRow: boolean;
  comped: boolean;
  pausedAt: string | null;
  pauseReason: string | null;
  runwayDays: number | null;
  ledger: LedgerRow[];
};

/**
 * One athlete's full detail: identity, live billing/pause state, and the most
 * recent ledger rows (the audit trail). Returns null when the athlete id is
 * unknown. `limit` caps the ledger history shown.
 */
export async function getAthleteDetail(
  athleteId: string,
  limit = 100,
): Promise<AthleteDetail | null> {
  const db = supabaseAdmin();

  const { data: a, error: aErr } = await db
    .from('athletes')
    .select('id, name, telegram_chat_id, paused_at, pause_reason')
    .eq('id', athleteId)
    .maybeSingle();
  if (aErr) throw aErr;
  if (!a) return null;

  const { data: credit, error: cErr } = await db
    .from('athlete_credits')
    .select('balance_cents, comped')
    .eq('athlete_id', athleteId)
    .maybeSingle();
  if (cErr) throw cErr;

  const { data: ledger, error: lErr } = await db
    .from('credit_ledger')
    .select(
      'id, kind, amount_cents, balance_after_cents, note, related_run_id, stripe_payment_intent, created_at',
    )
    .eq('athlete_id', athleteId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (lErr) throw lErr;

  const balanceCents = credit?.balance_cents ?? 0;
  const comped = credit?.comped ?? false;
  const chatId = (a.telegram_chat_id as string | null) ?? null;

  return {
    athleteId: a.id as string,
    name: a.name as string,
    telegramChatId: chatId,
    isTest: !!chatId && chatId.startsWith('-'),
    balanceCents,
    hasCreditsRow: !!credit,
    comped,
    pausedAt: (a.paused_at as string | null) ?? null,
    pauseReason: (a.pause_reason as string | null) ?? null,
    runwayDays: comped ? null : await estimateRunwayDays(balanceCents, athleteId),
    ledger: (ledger ?? []).map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      amountCents: r.amount_cents as number,
      balanceAfterCents: r.balance_after_cents as number,
      note: (r.note as string | null) ?? null,
      relatedRunId: (r.related_run_id as string | null) ?? null,
      stripePaymentIntent: (r.stripe_payment_intent as string | null) ?? null,
      createdAt: r.created_at as string,
    })),
  };
}
