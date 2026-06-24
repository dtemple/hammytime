// Metering & payments — read models for the David-only admin console
// (Specs/METERING_PAYMENTS.md §11, step 7). Pure composition over the existing
// billing tables + helpers; the mutations (adjust, comped toggle) live in
// credits.ts. Console-only, so it's kept out of the hot-path credits module.

import { supabaseAdmin } from '@/lib/db';
import { estimateRunwayDays } from './burn-rate';
import { daysUntilAutoPause, INACTIVITY_WINDOW_DAYS } from '@/server/telegram/pause';
import { isOnboarded } from '@/server/telegram/onboarding';

type OnboardingState = { flow?: string; phase?: string; step?: number } | null;

/** Most-recent inbound message time (ms) per athlete inside the inactivity
 *  window — the same bounded query the cron's activity scan uses (§10.5). */
async function lastInboundWithinWindow(
  db: ReturnType<typeof supabaseAdmin>,
  cutoffMs: number,
): Promise<Map<string, number>> {
  const { data, error } = await db
    .from('messages')
    .select('athlete_id, sent_at')
    .eq('direction', 'in')
    .gte('sent_at', new Date(cutoffMs).toISOString());
  if (error) throw error;
  const map = new Map<string, number>();
  for (const m of data ?? []) {
    const t = new Date(m.sent_at as string).getTime();
    const id = m.athlete_id as string;
    const prev = map.get(id);
    if (prev == null || t > prev) map.set(id, t);
  }
  return map;
}

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
  /** Days until inactivity auto-pause (§10.5); null when not eligible (test,
   *  not onboarded, or already paused). <= 0 means the next cron tick pauses. */
  autoPauseInDays: number | null;
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
    .select('id, name, telegram_chat_id, paused_at, pause_reason, created_at, onboarding_state')
    .order('name', { ascending: true });
  if (aErr) throw aErr;

  const { data: credits, error: cErr } = await db
    .from('athlete_credits')
    .select('athlete_id, balance_cents, comped');
  if (cErr) throw cErr;

  const creditsById = new Map((credits ?? []).map((c) => [c.athlete_id as string, c]));

  const nowMs = Date.now();
  const cutoffMs = nowMs - INACTIVITY_WINDOW_DAYS * 86_400_000;
  const lastInboundById = await lastInboundWithinWindow(db, cutoffMs);

  const rows: RosterRow[] = [];
  for (const a of athletes ?? []) {
    const credit = creditsById.get(a.id as string);
    const balanceCents = credit?.balance_cents ?? 0;
    const comped = credit?.comped ?? false;
    // Runway is meaningless for a comped athlete (nothing draws down).
    const runwayDays = comped ? null : await estimateRunwayDays(balanceCents, a.id as string);
    const chatId = (a.telegram_chat_id as string | null) ?? null;
    const isTest = !!chatId && chatId.startsWith('-');
    const pausedAt = (a.paused_at as string | null) ?? null;
    // The cron only evaluates onboarded, non-test, not-yet-paused athletes — so
    // the countdown is meaningful only there. Everyone else shows "—".
    const eligible =
      !isTest && pausedAt == null && isOnboarded(a.onboarding_state as OnboardingState);
    const autoPauseInDays = eligible
      ? daysUntilAutoPause(
          { created_at: a.created_at as string },
          lastInboundById.get(a.id as string) ?? null,
          nowMs,
        )
      : null;
    rows.push({
      athleteId: a.id as string,
      name: a.name as string,
      telegramChatId: chatId,
      isTest,
      balanceCents,
      hasCreditsRow: !!credit,
      comped,
      pausedAt,
      pauseReason: (a.pause_reason as string | null) ?? null,
      runwayDays,
      autoPauseInDays,
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
  /** True for an onboarded, non-test athlete — the ones the daily cron drives
   *  and the manual-pause control applies to. */
  pausable: boolean;
  /** Days until inactivity auto-pause; null when not eligible or already paused. */
  autoPauseInDays: number | null;
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
    .select('id, name, telegram_chat_id, paused_at, pause_reason, created_at, onboarding_state')
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
  const isTest = !!chatId && chatId.startsWith('-');
  const pausedAt = (a.paused_at as string | null) ?? null;
  const pausable = !isTest && isOnboarded(a.onboarding_state as OnboardingState);

  let autoPauseInDays: number | null = null;
  if (pausable && pausedAt == null) {
    const nowMs = Date.now();
    const cutoffMs = nowMs - INACTIVITY_WINDOW_DAYS * 86_400_000;
    const { data: lastIn } = await db
      .from('messages')
      .select('sent_at')
      .eq('athlete_id', athleteId)
      .eq('direction', 'in')
      .gte('sent_at', new Date(cutoffMs).toISOString())
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastInboundMs = lastIn?.sent_at ? new Date(lastIn.sent_at as string).getTime() : null;
    autoPauseInDays = daysUntilAutoPause(
      { created_at: a.created_at as string },
      lastInboundMs,
      nowMs,
    );
  }

  return {
    athleteId: a.id as string,
    name: a.name as string,
    telegramChatId: chatId,
    isTest,
    balanceCents,
    hasCreditsRow: !!credit,
    comped,
    pausedAt,
    pauseReason: (a.pause_reason as string | null) ?? null,
    runwayDays: comped ? null : await estimateRunwayDays(balanceCents, athleteId),
    pausable,
    autoPauseInDays,
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
