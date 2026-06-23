-- ---------------------------------------------------------------------------
-- Metering & payments — step 3 of Specs/METERING_PAYMENTS.md §12 (§6: Stripe
-- Checkout top-ups; §11: refunds mirrored from the Stripe dashboard).
--
-- Adds ONE parameterized RPC that mirrors a Stripe money event into the ledger:
--   apply_stripe_credit(athlete_id, payment_intent, amount_cents, kind)
--     kind='topup'  → caller passes +gross_cents  → balance rises
--     kind='refund' → caller passes -refunded_cents → balance falls
--   Writes the credit_ledger row (signed) AND bumps athlete_credits.balance_cents
--   in one transaction, mirroring grant_signup_credit / debit_run_credit. On a
--   topup it also clears low_balance_warned_at (§8 — a top-up re-arms the warning
--   for the next cycle), atomically with the balance bump.
--
-- topup and refund are mirror images (same write shape, opposite sign), so this
-- is one parameterized function rather than two — David's call (step 3, 2026-06-23).
--
-- Idempotency is enforced in the DB (not just app logic) by a partial unique
-- index on (stripe_payment_intent, kind). A replayed webhook hits the index and
-- rolls back to a no-op. The index is keyed PER KIND, not on the payment_intent
-- alone, because a topup and its later refund share the same payment_intent — a
-- single-column unique would wrongly reject the refund. (NB: this means at most
-- one refund row per charge; partial/multiple refunds on one charge are a v1
-- limitation — see METERING_PAYMENTS.md §11. Friends, full refunds from the
-- dashboard, so acceptable.)
--
-- Cents only; no floats on money. SECURITY INVOKER + service_role-only execute,
-- matching grant_signup_credit / debit_run_credit and the rest of the schema.
-- ---------------------------------------------------------------------------

-- Idempotency guard: one ledger row per (payment_intent, kind). The partial
-- predicate excludes the null-bearing grant/debit/adjust rows, so it never
-- collides with them. DB-level twin of credit_ledger_one_grant_per_athlete and
-- credit_ledger_one_debit_per_run.
create unique index credit_ledger_one_stripe_event_per_kind
  on credit_ledger (stripe_payment_intent, kind)
  where stripe_payment_intent is not null;

-- ---------------------------------------------------------------------------
-- apply_stripe_credit — mirror a Stripe topup/refund into the ledger + balance.
--
-- Returns true if it wrote the row, false on a skip (replay of the same
-- payment_intent+kind). p_amount_cents is SIGNED by the caller: positive for a
-- topup, negative for a refund. The ledger stores it as-is and the balance is
-- bumped by the same signed amount.
-- ---------------------------------------------------------------------------
create or replace function apply_stripe_credit(
  p_athlete_id     uuid,
  p_payment_intent text,
  p_amount_cents   int,
  p_kind           text
)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_new_balance int;
begin
  if p_kind not in ('topup', 'refund') then
    raise exception 'apply_stripe_credit: invalid kind %', p_kind;
  end if;
  if p_payment_intent is null then
    raise exception 'apply_stripe_credit: payment_intent is required';
  end if;

  -- Idempotency fast path: this (payment_intent, kind) already recorded → no-op.
  -- The partial unique index below is the real guard against a concurrent
  -- double-apply (the second insert raises unique_violation, handled below).
  if exists (
    select 1 from credit_ledger
    where stripe_payment_intent = p_payment_intent and kind = p_kind
  ) then
    return false;
  end if;

  -- Cache (athlete_credits): apply the signed delta. The row exists for every
  -- onboarded athlete (the signup grant created it); the insert branch only
  -- fires for the degenerate no-row case. On a topup, also clear the low-balance
  -- warning dedupe (§8) in the same transaction so the next cycle warns again.
  insert into athlete_credits (athlete_id, balance_cents, low_balance_warned_at, updated_at)
  values (p_athlete_id, p_amount_cents, null, now())
  on conflict (athlete_id) do update
    set balance_cents         = athlete_credits.balance_cents + p_amount_cents,
        low_balance_warned_at = case
                                  when p_kind = 'topup' then null
                                  else athlete_credits.low_balance_warned_at
                                end,
        updated_at            = now()
  returning balance_cents into v_new_balance;

  -- Source of truth (credit_ledger): append the signed row, keyed to the Stripe
  -- payment_intent. A concurrent second apply for the same (pi, kind) violates
  -- the partial unique index and rolls this whole function back to a no-op.
  insert into credit_ledger (
    athlete_id, kind, amount_cents, balance_after_cents, stripe_payment_intent, note
  )
  values (
    p_athlete_id, p_kind, p_amount_cents, v_new_balance, p_payment_intent,
    case when p_kind = 'topup' then 'stripe topup' else 'stripe refund' end
  );

  return true;
exception
  when unique_violation then
    -- Lost a concurrent race; the other transaction recorded this event. No-op.
    return false;
end;
$$;

revoke execute on function apply_stripe_credit(uuid, text, int, text) from public, anon, authenticated;
grant  execute on function apply_stripe_credit(uuid, text, int, text) to service_role;
