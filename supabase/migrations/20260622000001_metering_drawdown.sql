-- ---------------------------------------------------------------------------
-- Metering & payments — step 2 of Specs/METERING_PAYMENTS.md §12 (§5: draw-down).
--
-- Adds the per-run debit RPC that the worker calls after a run persists:
--   debit_run_credit(athlete_id, run_id, amount_cents) — writes a kind='debit'
--   ledger row (signed-negative) AND decrements athlete_credits.balance_cents in
--   one transaction, mirroring grant_signup_credit. Comped athletes are a no-op.
--
-- Idempotency is enforced in the DB (not just app logic) by a partial unique
-- index on credit_ledger(related_run_id) where kind='debit' — one debit per run,
-- ever. A retried/re-persisted run hits the index and rolls back to a no-op.
--
-- The 1.5× markup is NOT here: the cents to debit are computed in TS
-- (src/server/billing/pricing.ts → billedCents) so worker and web share one
-- source of truth for the markup. This RPC takes already-computed cents.
--
-- Cents only; no floats on money. SECURITY INVOKER + service_role-only execute,
-- matching grant_signup_credit and the rest of the schema.
-- ---------------------------------------------------------------------------

-- Idempotency guard: exactly one kind='debit' row per run, ever. related_run_id
-- is nullable on the table, but a debit row always carries it, and the partial
-- predicate (kind='debit') excludes the null-bearing grant/topup/adjust rows —
-- so this never collides with them. This is the DB-level twin of the grant guard
-- (credit_ledger_one_grant_per_athlete).
create unique index credit_ledger_one_debit_per_run on credit_ledger (related_run_id)
  where kind = 'debit';

-- ---------------------------------------------------------------------------
-- debit_run_credit — per-run draw-down at 1.5× (cents computed caller-side).
--
-- Returns true if it debited, false on a skip (comped, or already debited for
-- this run). p_amount_cents is the POSITIVE billed amount; the ledger stores it
-- signed-negative and the balance is decremented by the same magnitude.
--
-- Overshoot into a slight negative balance is allowed by design (§5): the
-- in-flight run that drove the athlete to/past $0 always completes and lands the
-- balance wherever it lands. The pre-run gate (worker-side) is what refuses the
-- NEXT run; this function never clamps.
-- ---------------------------------------------------------------------------
create or replace function debit_run_credit(
  p_athlete_id   uuid,
  p_run_id       uuid,
  p_amount_cents int
)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_new_balance int;
begin
  -- Comped athletes are never debited (§4). Defense in depth — the worker also
  -- never reaches a debit for a comped athlete in the common path, but a single
  -- source of truth for "comped skips billing" lives here too.
  if exists (
    select 1 from athlete_credits where athlete_id = p_athlete_id and comped
  ) then
    return false;
  end if;

  -- Idempotency fast path: this run already debited → no-op. The partial unique
  -- index below is the real guard against a concurrent double-debit (the second
  -- insert raises unique_violation, handled below).
  if exists (
    select 1 from credit_ledger where related_run_id = p_run_id and kind = 'debit'
  ) then
    return false;
  end if;

  -- Cache (athlete_credits): decrement the balance. The row exists for every
  -- onboarded athlete (the signup grant created it); the insert branch only
  -- fires for the degenerate no-row case, landing a negative starting balance.
  insert into athlete_credits (athlete_id, balance_cents, updated_at)
  values (p_athlete_id, -p_amount_cents, now())
  on conflict (athlete_id) do update
    set balance_cents = athlete_credits.balance_cents - p_amount_cents,
        updated_at    = now()
  returning balance_cents into v_new_balance;

  -- Source of truth (credit_ledger): append the signed-negative debit row,
  -- referencing the run. A concurrent second debit for the same run violates the
  -- partial unique index and rolls this whole function back to a no-op.
  insert into credit_ledger (
    athlete_id, kind, amount_cents, balance_after_cents, related_run_id, note
  )
  values (
    p_athlete_id, 'debit', -p_amount_cents, v_new_balance, p_run_id, 'run debit'
  );

  return true;
exception
  when unique_violation then
    -- Lost a concurrent race; the other transaction recorded the debit. No-op.
    return false;
end;
$$;

revoke execute on function debit_run_credit(uuid, uuid, int) from public, anon, authenticated;
grant  execute on function debit_run_credit(uuid, uuid, int) to service_role;
